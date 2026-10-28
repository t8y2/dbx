#![recursion_limit = "256"]

use dbx_core::connection::{session_credentials::with_credential_owner, AppState};
use dbx_core::models::connection::{ConnectionConfig, DatabaseConnectionInfo};
use dbx_core::schema::native_jobs::{
    native_job_list_with, native_job_open_context_with, native_job_read_with, native_job_references_with,
    NativeJobCatalogFailure, NativeJobRuntimeIdentity,
};
use dbx_sql::native_jobs::NativeJobCatalogQuery;
use dbx_types::native_jobs::{
    NativeJobArgumentValue, NativeJobCatalogCoverage, NativeJobContext, NativeJobEngine, NativeJobKind,
    NativeJobListRequest, NativeJobMetadata, NativeJobRef, NativeJobReferenceKind, NativeJobReferenceListRequest,
};
use serde_json::{json, Value};

async fn state(db_type: &str) -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        directory.path().join("plugins"),
        directory.path().join("agents"),
        "0.0.0",
    );
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "connection", "name": "Job fixture", "db_type": db_type, "host": "127.0.0.1", "port": 1,
        "username": "Owner", "password": "", "database": ""
    }))
    .unwrap();
    state.configs.write().await.insert("connection".into(), config);
    (directory, state)
}

fn identity() -> NativeJobRuntimeIdentity {
    NativeJobRuntimeIdentity {
        database_info: Some(DatabaseConnectionInfo {
            product_name: Some("Oracle".into()),
            current_database: Some("PDB".into()),
            ..Default::default()
        }),
        session_user: "Owner".into(),
    }
}

async fn context(state: &AppState) -> NativeJobContext {
    native_job_open_context_with(state, "connection", "", |_| std::future::ready(Ok(identity()))).await.unwrap()
}

fn target(context: &NativeJobContext) -> NativeJobRef {
    NativeJobRef::Scheduler { scope: context.scope.clone(), owner: "Owner".into(), name: "Job".into() }
}

fn result(columns: &[&str], rows: Value) -> Value {
    json!({ "columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 1 })
}

#[tokio::test]
async fn dm_legacy_definition_preserves_the_native_partition_and_exact_id() {
    let (_directory, state) = state("dameng").await;
    let target = NativeJobRef::Legacy { scope: context(&state).await.scope, job_id: "900719925474099312345".into() };
    let mut first_revision: Option<String> = None;
    for mode in ["available", "next-date-shift", "changed-body", "denied", "empty", "wrong-id"] {
        let details = native_job_read_with(&state, &target, |query| {
            std::future::ready(if query.source == "SYSJOB.DBA_JOBS" || query.source == "SYSJOB.USER_JOBS" {
                match mode {
                    "denied" => Err(NativeJobCatalogFailure::Denied(None)),
                    "empty" => Ok(result(&["DBX_JOB_ID", "WHAT"], json!([]))),
                    _ => Ok(result(
                        &["DBX_JOB_ID", "WHAT", "NEXT_DATE", "INTERVAL", "INSTANCE"],
                        json!([[
                            if mode == "wrong-id" { "41" } else { "900719925474099312345" },
                            if mode == "changed-body" {
                                "external_change();"
                            } else {
                                "begin\n  work('多字节');\nend;  "
                            },
                            if mode == "next-date-shift" { "another native date" } else { "native unparsed date" },
                            "86400",
                            2
                        ]]),
                    )),
                }
            } else if query.sql.contains("DBX_CREATED_AT") {
                Ok(result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["900719925474099312345", "created"]])))
            } else if query.source == "SYSJOB.SYSJOBS" {
                Ok(result(
                    &["DBX_JOB_ID", "ID", "NAME", "USERNAME", "ENABLE", "SYS_FLAG"],
                    json!([["900719925474099312345", "900719925474099312345", "Legacy Native Name", "Owner", 0, 2]]),
                ))
            } else {
                Ok(result(&["JOBID"], json!([])))
            })
        })
        .await
        .unwrap();
        assert!(
            matches!(&details.snapshot.definition, NativeJobMetadata::Available { value } if value["NAME"] == json!("Legacy Native Name") && !value.contains_key("WHAT"))
        );
        assert!(matches!(details.consistency, NativeJobMetadata::Available { .. }));
        let legacy = details.legacy_definition.as_ref().unwrap();
        match mode {
            "available" => {
                assert!(
                    matches!(legacy, NativeJobMetadata::Available { value } if value["WHAT"] == json!("begin\n  work('多字节');\nend;  ") && value["NEXT_DATE"] == json!("native unparsed date") && value["INTERVAL"] == json!("86400") && value["INSTANCE"] == json!(2))
                );
                assert_eq!(details.sources["legacyDefinition"].source.as_deref(), Some("SYSJOB.DBA_JOBS"));
            }
            "next-date-shift" | "changed-body" => assert!(matches!(legacy, NativeJobMetadata::Available { .. })),
            "denied" => assert!(matches!(legacy, NativeJobMetadata::Denied { .. })),
            "empty" => assert!(matches!(legacy, NativeJobMetadata::Empty)),
            _ => assert!(
                matches!(legacy, NativeJobMetadata::Error { reason } if reason == "native_job_catalog_identity_mismatch")
            ),
        }
        if let Some(previous) = &first_revision {
            assert_eq!(
                state.native_jobs.compare_baseline(
                    &state,
                    &target,
                    previous,
                    &details.snapshot.revision,
                    &["definition"],
                    false
                ),
                Ok(())
            );
            assert_eq!(
                state.native_jobs.compare_baseline(
                    &state,
                    &target,
                    previous,
                    &details.snapshot.revision,
                    &["legacyDefinition"],
                    false
                ),
                match mode {
                    "next-date-shift" => Ok(()),
                    "changed-body" => Err("native_job_definition_changed"),
                    _ => Err("native_job_metadata_incomplete"),
                }
            );
        } else {
            first_revision = Some(details.snapshot.revision.clone());
        }
    }
}

fn reference_request(context: &NativeJobContext) -> NativeJobReferenceListRequest {
    NativeJobReferenceListRequest {
        scope: context.scope.clone(),
        kind: NativeJobReferenceKind::Program,
        schema: None,
        name: None,
        filter: String::new(),
        offset: 0,
        limit: 100,
    }
}

#[tokio::test]
async fn program_reference_defaults_use_the_shared_lossless_codec_and_preserve_raw_columns() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let mut request = reference_request(&ctx);
    request.kind = NativeJobReferenceKind::ProgramArguments;
    request.schema = Some("Owner".into());
    request.name = Some("Program".into());
    let read = native_job_references_with(&state, &request, |_| {
        std::future::ready(Ok(result(
            &[
                "DBX_OWNER",
                "DBX_NAME",
                "ARGUMENT_POSITION",
                "ARGUMENT_TYPE",
                "DEFAULT_VALUE",
                "DEFAULT_ANYDATA_VALUE",
                "DBX_ANYDATA_PRESENT",
                "DBX_ANYDATA_TYPE",
                "DBX_ANYDATA_IS_NULL",
                "DBX_ANYDATA_TEXT",
            ],
            json!([
                [
                    "Owner",
                    "Program",
                    1,
                    "NUMBER",
                    "wrong text",
                    "locator 1",
                    1,
                    "SYS.NUMBER",
                    0,
                    "9007199254740993.123"
                ],
                ["Owner", "Program", 2, "VARCHAR2", "wrong text", "locator 2", 1, "SYS.CHAR", 1, null],
                ["Owner", "Program", 3, "OBJECT", "wrong text", "locator 3", 1, "APP.OBJECT", 0, null]
            ]),
        )))
    })
    .await
    .unwrap();
    let NativeJobMetadata::Available { value } = read.objects else { panic!("catalog required") };
    assert_eq!(value[0]["DEFAULT_VALUE"], "wrong text");
    assert_eq!(value[0]["DEFAULT_ANYDATA_VALUE"], "locator 1");
    assert_eq!(
        value[0]["DBX_ARGUMENT_DEFAULT"],
        json!({"status":"available","value":{"kind":"value","value":{"$dbx":"oracle-anydata-v1","typeName":"SYS.NUMBER","value":"9.007199254740993123E15"}}})
    );
    assert_eq!(
        value[1]["DBX_ARGUMENT_DEFAULT"],
        json!({"status":"available","value":{"kind":"value","value":{"$dbx":"oracle-anydata-v1","scalarType":"char","value":null}}})
    );
    assert_eq!(value[2]["DBX_ARGUMENT_DEFAULT"]["value"]["kind"], "opaque");
}

#[tokio::test]
async fn references_share_the_authenticated_context_and_reject_scope_changes_before_query() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let mut request = reference_request(&ctx);
    let mut calls = 0;
    request.scope.database = "another database".into();
    let read = native_job_references_with(&state, &request, |_| {
        calls += 1;
        std::future::ready(Err(NativeJobCatalogFailure::Transport))
    })
    .await;
    assert!(matches!(read, Err("native_job_context_expired")));
    assert_eq!(calls, 0);
    request.scope = ctx.scope;
    let read = with_credential_owner(
        Some("another-authenticated-owner".into()),
        native_job_references_with(&state, &request, |_| {
            calls += 1;
            std::future::ready(Err(NativeJobCatalogFailure::Transport))
        }),
    )
    .await;
    assert!(matches!(read, Err("native_job_context_expired")));
    assert_eq!(calls, 0);
}

#[tokio::test]
async fn references_only_fall_back_after_typed_catalog_failures_and_keep_source_coverage() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let request = reference_request(&ctx);
    let mut calls = Vec::new();
    let read = native_job_references_with(&state, &request, |query| {
        calls.push(query.source);
        std::future::ready(if query.source == "SYS.DBA_SCHEDULER_PROGRAMS" {
            Err(NativeJobCatalogFailure::Denied(Some(1031)))
        } else {
            Ok(result(&["DBX_OWNER", "DBX_NAME", "ENABLED"], json!([["Owner.One", "Exact,\"Program", "TRUE"]])))
        })
    })
    .await
    .unwrap();
    assert_eq!(calls, ["SYS.DBA_SCHEDULER_PROGRAMS", "SYS.ALL_SCHEDULER_PROGRAMS"]);
    assert_eq!(read.source.coverage, Some(NativeJobCatalogCoverage::Accessible));
    let NativeJobMetadata::Available { value } = read.objects else { panic!("catalog unavailable") };
    assert_eq!(value[0]["DBX_NAME"], "Exact,\"Program");
    for failure in [None, Some(NativeJobCatalogFailure::Query(Some(6550)))] {
        let mut calls = 0;
        let read = native_job_references_with(&state, &request, |_| {
            calls += 1;
            std::future::ready(match &failure {
                Some(error) => Err(error.clone()),
                None => Ok(result(&["DBX_OWNER", "DBX_NAME"], json!([]))),
            })
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert!(match failure {
            None => matches!(read.objects, NativeJobMetadata::Empty),
            Some(_) => matches!(read.objects, NativeJobMetadata::Error { .. }),
        });
    }
}

#[tokio::test]
async fn reference_identity_faults_do_not_fall_back_and_program_argument_positions_are_unique() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let mut request = reference_request(&ctx);
    request.schema = Some("Owner".into());
    request.name = Some("Program".into());
    for (columns, rows) in [
        (vec!["DBX_OWNER", "DBX_NAME"], json!([["Another", "Program"]])),
        (vec!["DBX_OWNER", "DBX_NAME"], json!([["Owner", "Program"], ["Owner", "Program"]])),
    ] {
        let mut calls = 0;
        let read = native_job_references_with(&state, &request, |_| {
            calls += 1;
            std::future::ready(Ok(result(&columns, rows.clone())))
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert!(matches!(read.objects, NativeJobMetadata::Error { .. }));
    }
    request.kind = NativeJobReferenceKind::ProgramArguments;
    let read = native_job_references_with(&state, &request, |_| {
        std::future::ready(Ok(result(
            &["DBX_OWNER", "DBX_NAME", "ARGUMENT_POSITION", "DEFAULT_VALUE"],
            json!([["Owner", "Program", 1, "keep default"], ["Owner", "Program", 2, null]]),
        )))
    })
    .await
    .unwrap();
    assert!(matches!(read.objects, NativeJobMetadata::Available { value } if value.len() == 2));
}

#[tokio::test]
async fn reference_group_categories_reject_a_wrong_or_missing_native_type_without_fallback() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    for (kind, accepted, rejected) in [
        (NativeJobReferenceKind::WindowGroup, vec!["WINDOW"], vec!["JOB", "DB_DEST", "EXTERNAL_DEST", ""]),
        (NativeJobReferenceKind::DestinationGroup, vec!["DB_DEST", "EXTERNAL_DEST"], vec!["WINDOW", "JOB", ""]),
    ] {
        let mut request = reference_request(&ctx);
        request.kind = kind;
        for group_type in accepted.iter().chain(&rejected) {
            let mut calls = 0;
            let read = native_job_references_with(&state, &request, |_| {
                calls += 1;
                std::future::ready(Ok(result(
                    &["DBX_OWNER", "DBX_NAME", "GROUP_TYPE"],
                    json!([["SYS", "Exact.Group,One", group_type]]),
                )))
            })
            .await
            .unwrap();
            assert_eq!(calls, 1);
            assert_eq!(matches!(read.objects, NativeJobMetadata::Available { .. }), accepted.contains(group_type));
        }
        let read = native_job_references_with(&state, &request, |_| {
            std::future::ready(Ok(result(&["DBX_OWNER", "DBX_NAME"], json!([["SYS", "Group"]]))))
        })
        .await
        .unwrap();
        assert!(matches!(read.objects, NativeJobMetadata::Error { .. }));
    }
}

#[tokio::test]
async fn destination_group_inventory_keeps_raw_credentials_and_distinguishes_empty_invalid_and_truncated() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let mut request = reference_request(&ctx);
    request.kind = NativeJobReferenceKind::DestinationGroupMembers;
    request.schema = Some("Owner".into());
    request.name = Some("Group".into());
    let columns = ["DBX_OWNER", "DBX_NAME", "MEMBER_NAME"];
    for (rows, available) in [
        (json!([["Owner", "Group", "Credential@Database.1"], ["Owner", "Group", "Database.2"]]), true),
        (json!([["Owner", "Group", "Database.1"], ["Owner", "Group", "Database.1"]]), false),
        (json!([["Owner", "OtherGroup", "Database.1"]]), false),
        (json!([["Owner", "Group", null]]), false),
        (json!([["Owner", "Group", ""]]), false),
    ] {
        let mut reads = 0;
        let catalog = native_job_references_with(&state, &request, |_| {
            reads += 1;
            std::future::ready(Ok(result(&columns, rows.clone())))
        })
        .await
        .unwrap();
        assert_eq!(reads, 1);
        if available {
            let NativeJobMetadata::Available { value } = catalog.objects else { panic!("missing exact members") };
            assert_eq!(value[0]["MEMBER_NAME"], json!("Credential@Database.1"));
        } else {
            assert!(matches!(catalog.objects, NativeJobMetadata::Error { .. }));
        }
    }
    let empty = native_job_references_with(&state, &request, |_| std::future::ready(Ok(result(&columns, json!([])))))
        .await
        .unwrap();
    assert!(matches!(empty.objects, NativeJobMetadata::Empty));
    request.limit = 1;
    let truncated = native_job_references_with(&state, &request, |_| {
        std::future::ready(Ok(result(&columns, json!([["Owner", "Group", "One"], ["Owner", "Group", "Two"]]))))
    })
    .await
    .unwrap();
    assert!(matches!(truncated.objects, NativeJobMetadata::Truncated { limit: 1, .. }));
}

#[tokio::test]
async fn another_owners_destination_members_cannot_become_empty_through_a_user_only_fallback() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    for owner in ["OtherOwner", "Owner"] {
        let mut request = reference_request(&ctx);
        request.kind = NativeJobReferenceKind::DestinationGroupMembers;
        request.schema = Some(owner.into());
        request.name = Some("Group".into());
        let mut reads = Vec::new();
        let catalog = native_job_references_with(&state, &request, |query| {
            reads.push(query.source);
            std::future::ready(if query.coverage == NativeJobCatalogCoverage::CurrentUser {
                Ok(result(&["DBX_OWNER", "DBX_NAME", "MEMBER_NAME"], json!([])))
            } else {
                Err(NativeJobCatalogFailure::Denied(Some(1031)))
            })
        })
        .await
        .unwrap();
        if owner == "Owner" {
            assert!(matches!(catalog.objects, NativeJobMetadata::Empty));
            assert_eq!(reads.len(), 3);
        } else {
            assert!(matches!(catalog.objects, NativeJobMetadata::Denied { .. }));
            assert_eq!(reads.len(), 2);
        }
    }
}

#[tokio::test]
async fn only_oracle_scheduler_baselines_classify_the_three_native_generated_observations() {
    for db_type in ["oracle", "oceanbase-oracle", "dameng"] {
        let (_directory, state) = state(db_type).await;
        let job = target(&context(&state).await);
        let read = |version| {
            native_job_read_with(&state, &job, move |query| {
                std::future::ready(Ok(if query.sql.contains("AS DBX_JOB_ID") {
                    result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "created"]]))
                } else if query.source.ends_with("SCHEDULER_JOBS") {
                    result(
                        &["OWNER", "JOB_NAME", "NUMBER_OF_ARGUMENTS", "FLAGS", "EVENT_RULE", "NUMBER_OF_DESTINATIONS"],
                        json!([["Owner", "Job", 0, version, format!("native-rule-{version}"), version]]),
                    )
                } else {
                    result(&["JOB_NAME"], json!([]))
                }))
            })
        };
        let before = read(0).await.unwrap();
        let after = read(1).await.unwrap();
        assert!(
            matches!(&after.snapshot.definition, NativeJobMetadata::Available { value } if value["FLAGS"] == json!(1)),
            "raw observation lost for {db_type}"
        );
        let compared = state.native_jobs.compare_baseline(
            &state,
            &job,
            &before.snapshot.revision,
            &after.snapshot.revision,
            &["definition"],
            false,
        );
        assert_eq!(compared.is_ok(), db_type == "oracle", "{db_type}: {compared:?}");
    }
}

#[tokio::test]
async fn watcher_queue_observations_do_not_mask_queue_jobs_or_changed_watcher_identity_and_condition() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    for (watcher, changed) in [(true, "queue"), (false, "queue"), (true, "watcher"), (true, "condition")] {
        let read = |after| {
            native_job_read_with(&state, &job, move |query| {
                std::future::ready(Ok(if query.sql.contains("AS DBX_JOB_ID") {
                    result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "created"]]))
                } else if query.source.ends_with("SCHEDULER_JOBS") {
                    result(
                        &[
                            "OWNER",
                            "JOB_NAME",
                            "NUMBER_OF_ARGUMENTS",
                            "FILE_WATCHER_OWNER",
                            "FILE_WATCHER_NAME",
                            "EVENT_CONDITION",
                            "EVENT_QUEUE_OWNER",
                            "EVENT_QUEUE_NAME",
                            "EVENT_QUEUE_AGENT",
                        ],
                        json!([[
                            "Owner",
                            "Job",
                            0,
                            if watcher { json!("Owner") } else { Value::Null },
                            if watcher {
                                json!(if after && changed == "watcher" { "OtherWatcher" } else { "Watcher" })
                            } else {
                                Value::Null
                            },
                            if after && changed == "condition" { json!("TRUE") } else { Value::Null },
                            "SYS",
                            if after { "NewQueue" } else { "OldQueue" },
                            "Agent"
                        ]]),
                    )
                } else {
                    result(&["JOB_NAME"], json!([]))
                }))
            })
        };
        let before = read(false).await.unwrap();
        let after = read(true).await.unwrap();
        let compared = state.native_jobs.compare_baseline(
            &state,
            &job,
            &before.snapshot.revision,
            &after.snapshot.revision,
            &["definition"],
            false,
        );
        assert_eq!(compared.is_ok(), watcher && changed == "queue", "{watcher} {changed}: {compared:?}");
    }
}

#[tokio::test]
async fn references_preserve_paging_and_a_context_invalidated_during_read_cannot_return_choices() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let mut request = reference_request(&ctx);
    request.limit = 1;
    request.offset = 100;
    let read = native_job_references_with(&state, &request, |_| {
        std::future::ready(Ok(result(
            &["DBX_OWNER", "DBX_NAME"],
            json!([["Owner", "Program1"], ["Owner", "Program2"]]),
        )))
    })
    .await
    .unwrap();
    assert_eq!(read.offset, 100);
    assert_eq!(read.limit, 1);
    assert!(matches!(read.objects, NativeJobMetadata::Truncated { value, limit: 1 } if value.len() == 1));
    let read = native_job_references_with(&state, &request, |_| {
        state.invalidate_connection_lifecycle("connection");
        std::future::ready(Ok(result(&["DBX_OWNER", "DBX_NAME"], json!([["Owner", "Program"]]))))
    })
    .await;
    assert!(matches!(read, Err("native_job_context_changed") | Err("native_job_context_expired")));
}

fn fixture(
    query: NativeJobCatalogQuery,
    id: &str,
    body: &str,
    runs: i32,
    opaque: &str,
) -> Result<Value, NativeJobCatalogFailure> {
    if query.source.ends_with("_OBJECTS") {
        return Ok(result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([[id, "2026-10-20 20:00:00"]])));
    }
    if query.source.ends_with("SCHEDULER_JOBS") {
        return Ok(result(
            &[
                "OWNER",
                "JOB_NAME",
                "JOB_TYPE",
                "JOB_ACTION",
                "NUMBER_OF_ARGUMENTS",
                "STATE",
                "RUN_COUNT",
                "NEXT_RUN_DATE",
                "PROGRAM_NAME",
            ],
            json!([["Owner", "Job", "STORED_PROCEDURE", body, 2, "SCHEDULED", runs, format!("next-{runs}"), null]]),
        ));
    }
    if query.source.ends_with("JOB_ARGS") {
        return Ok(result(
            &[
                "OWNER",
                "JOB_NAME",
                "ARGUMENT_POSITION",
                "ARGUMENT_TYPE",
                "VALUE",
                "OUT_ARGUMENT",
                "ANYDATA_VALUE",
                "DBX_ANYDATA_PRESENT",
            ],
            json!([
                ["Owner", "Job", 1, "VARCHAR2", "known", "FALSE", null, 0],
                ["Owner", "Job", 2, "OBJECT", null, "FALSE", opaque, 1]
            ]),
        ));
    }
    if query.source.ends_with("RUNNING_JOBS") {
        return Err(NativeJobCatalogFailure::sql(
            dbx_sql::native_jobs::NativeJobCatalogDialect::Oracle,
            Some(942),
            None,
        ));
    }
    if query.source.ends_with("JOB_RUN_DETAILS") {
        return Ok(result(&["OWNER", "JOB_NAME", "LOG_ID"], json!([])));
    }
    panic!("unexpected catalog source")
}

#[tokio::test]
async fn context_is_reused_only_for_the_same_lifecycle_and_authentication_owner() {
    let (_directory, state) = state("oracle").await;
    let first = context(&state).await;
    let second = context(&state).await;
    assert_eq!(first.scope, second.scope);
    let another = with_credential_owner(Some("other-authenticated-session".into()), context(&state)).await;
    assert_ne!(first.scope.context_id, another.scope.context_id);
    let denied = with_credential_owner(
        Some("other-authenticated-session".into()),
        native_job_read_with(&state, &target(&first), |_| {
            std::future::ready::<Result<Value, NativeJobCatalogFailure>>(Err(NativeJobCatalogFailure::Transport))
        }),
    )
    .await;
    assert!(matches!(denied, Err("native_job_context_expired")));
    state.invalidate_connection_lifecycle("connection");
    let third = context(&state).await;
    assert_ne!(first.scope.context_id, third.scope.context_id);
}

#[tokio::test]
async fn a_configuration_change_during_identity_read_cannot_issue_a_context() {
    let (_directory, state) = state("oracle").await;
    let opened = native_job_open_context_with(&state, "connection", "", |_| {
        state.invalidate_connection_lifecycle("connection");
        std::future::ready(Ok(identity()))
    })
    .await;
    assert!(matches!(opened, Err("native_job_context_changed")));
}

#[tokio::test]
async fn oracle_context_opens_successfully_without_database_info() {
    let (_directory, state) = state("oracle").await;
    let ctx = native_job_open_context_with(&state, "connection", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "SYSTEM".into() }))
    })
    .await
    .unwrap();
    assert_eq!(ctx.engine, NativeJobEngine::Oracle);
    assert_eq!(ctx.session_user, "SYSTEM");
    assert!(ctx.product_version.is_none());
}

#[tokio::test]
async fn runtime_engine_discovery_does_not_assume_oceanbase_means_oracle_mode() {
    let (_directory, state) = state("jdbc").await;
    state.configs.write().await.get_mut("connection").unwrap().database_info = Some(DatabaseConnectionInfo {
        product_name: Some("OceanBase".into()),
        compatibility_mode: Some("oracle".into()),
        ..Default::default()
    });
    let oracle = native_job_open_context_with(&state, "connection", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity {
            database_info: Some(DatabaseConnectionInfo {
                product_name: Some("OceanBase".into()),
                compatibility_mode: Some("oracle".into()),
                ..Default::default()
            }),
            session_user: "Owner".into(),
        }))
    })
    .await
    .unwrap();
    assert_eq!(oracle.engine, NativeJobEngine::OceanbaseOracle);
    for mode in [None, Some("mysql")] {
        let opened = native_job_open_context_with(&state, "connection", "", |_| {
            std::future::ready(Ok(NativeJobRuntimeIdentity {
                database_info: Some(DatabaseConnectionInfo {
                    product_name: Some("OceanBase".into()),
                    compatibility_mode: mode.map(str::to_string),
                    ..Default::default()
                }),
                session_user: "Owner".into(),
            }))
        })
        .await;
        assert!(matches!(opened, Err("native_job_engine_unresolved")));
    }
}

#[tokio::test]
async fn dm_list_uses_one_native_record_for_a_proven_legacy_alias_and_never_fakes_running() {
    let (_directory, state) = state("dameng").await;
    let ctx = native_job_open_context_with(&state, "connection", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
    })
    .await
    .unwrap();
    let request = NativeJobListRequest {
        scope: ctx.scope,
        kind: NativeJobKind::DamengNative,
        schema: None,
        filter: "".into(),
        offset: 0,
        limit: 100,
    };
    let list = native_job_list_with(&state, &request, |query| {
        assert!(!query.sql.contains("COMMAND"));
        assert!(!query.sql.contains("RUNNING"));
        std::future::ready(Ok(result(
            &["DBX_JOB_ID", "NAME", "ENABLE", "USERNAME", "SYS_FLAG"],
            json!([["9007199254740993", "exact,name", 1, "Owner", 2]]),
        )))
    })
    .await
    .unwrap();
    let NativeJobMetadata::Available { value } = list.jobs else { panic!("list unavailable") };
    assert_eq!(value.len(), 1);
    assert!(matches!(&value[0].job_ref, NativeJobRef::Legacy { job_id, .. } if job_id == "9007199254740993"));
    assert!(matches!(&value[0].aliases[0], NativeJobRef::DamengNative { name, .. } if name == "exact,name"));
    assert!(value[0].state.is_none());
}

#[tokio::test]
async fn list_scope_tampering_is_rejected_before_any_database_query() {
    let (_directory, state) = state("oracle").await;
    let mut ctx = context(&state).await;
    ctx.scope.database = "another database".into();
    let request = NativeJobListRequest {
        scope: ctx.scope,
        kind: NativeJobKind::Scheduler,
        schema: None,
        filter: "".into(),
        offset: 0,
        limit: 100,
    };
    let mut calls = 0;
    let list = native_job_list_with(&state, &request, |_| {
        calls += 1;
        std::future::ready(Err(NativeJobCatalogFailure::Transport))
    })
    .await;
    assert!(matches!(list, Err("native_job_context_expired")));
    assert_eq!(calls, 0);
}

#[tokio::test]
async fn details_preserve_opaque_arguments_and_keep_unavailable_runtime_separate() {
    let (_directory, state) = state("oracle").await;
    let ctx = context(&state).await;
    let job = target(&ctx);
    let details = native_job_read_with(&state, &job, |query| {
        std::future::ready(fixture(query, "41", "first", 0, "opaque-object"))
    })
    .await
    .unwrap();
    assert!(!details.snapshot.revision.is_empty());
    assert!(matches!(details.consistency, NativeJobMetadata::Available { .. }));
    assert!(matches!(details.running, NativeJobMetadata::Unknown { .. }));
    assert!(matches!(details.history, NativeJobMetadata::Empty));
    let NativeJobMetadata::Available { value } = &details.snapshot.arguments else { panic!("arguments unavailable") };
    assert!(matches!(&value[0].value, NativeJobArgumentValue::Value { value } if value == "known"));
    assert!(matches!(value[1].value, NativeJobArgumentValue::Opaque { .. }));
    assert!(!value[1].editable);
}

#[tokio::test]
async fn truncated_argument_metadata_remains_raw_and_does_not_panic_or_authorize_an_empty_snapshot() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let read = native_job_read_with(&state, &job, |query| {
        std::future::ready(if query.source.ends_with("SCHEDULER_JOB_ARGS") {
            Ok(result(
                &["OWNER", "JOB_NAME", "ARGUMENT_POSITION"],
                Value::Array((1..=10_001).map(|position| json!(["Owner", "Job", position])).collect()),
            ))
        } else {
            fixture(query, "41", "body", 0, "opaque")
        })
    })
    .await
    .unwrap();
    assert!(matches!(read.parameter_metadata, NativeJobMetadata::Truncated { limit: 10_000, .. }));
    assert!(
        matches!(&read.snapshot.arguments, NativeJobMetadata::Unknown { reason } if reason == "native_job_arguments_truncated")
    );
    assert!(matches!(read.snapshot.definition, NativeJobMetadata::Available { .. }));
}

fn program_fixture(query: NativeJobCatalogQuery, default: &str) -> Result<Value, NativeJobCatalogFailure> {
    if query.source.ends_with("SCHEDULER_PROGRAMS") {
        return Ok(result(
            &["DBX_OWNER", "DBX_NAME", "NUMBER_OF_ARGUMENTS", "PROGRAM_ACTION"],
            json!([["Program.Owner", "Program,One", 3, "original_procedure"]]),
        ));
    }
    if query.source.ends_with("SCHEDULER_PROGRAM_ARGS") {
        return Ok(result(
            &[
                "DBX_OWNER",
                "DBX_NAME",
                "ARGUMENT_POSITION",
                "ARGUMENT_NAME",
                "ARGUMENT_TYPE",
                "DEFAULT_VALUE",
                "DEFAULT_ANYDATA_VALUE",
                "DBX_ANYDATA_PRESENT",
                "METADATA_ATTRIBUTE",
                "OUT_ARGUMENT",
            ],
            json!([
                ["Program.Owner", "Program,One", 1, "TEXT", "VARCHAR2", default, null, 0, null, "FALSE"],
                ["Program.Owner", "Program,One", 2, "OPTIONAL", "VARCHAR2", null, null, 0, null, "FALSE"],
                ["Program.Owner", "Program,One", 3, "NATIVE_NAME", "VARCHAR2", null, null, 0, "JOB_NAME", "FALSE"]
            ]),
        ));
    }
    if query.source.ends_with("SCHEDULER_JOBS") {
        return Ok(result(
            &[
                "OWNER",
                "JOB_NAME",
                "PROGRAM_OWNER",
                "PROGRAM_NAME",
                "JOB_TYPE",
                "JOB_ACTION",
                "NUMBER_OF_ARGUMENTS",
                "COMMENTS",
            ],
            json!([["Owner", "Job", "Program.Owner", "Program,One", null, null, null, "keep"]]),
        ));
    }
    if query.source.ends_with("SCHEDULER_JOB_ARGS") {
        return Ok(result(
            &[
                "OWNER",
                "JOB_NAME",
                "ARGUMENT_POSITION",
                "ARGUMENT_NAME",
                "ARGUMENT_TYPE",
                "VALUE",
                "OUT_ARGUMENT",
                "DBX_ANYDATA_PRESENT",
            ],
            json!([["Owner", "Job", 1, "TEXT", "VARCHAR2", "explicit override", "FALSE", 0]]),
        ));
    }
    fixture(query, "41", "unused", 0, "unused")
}

#[tokio::test]
async fn ordinary_argument_preview_cannot_follow_an_external_program_switch_with_identical_arguments() {
    use dbx_core::schema::native_jobs::{
        native_job_apply_with, native_job_prepare_with, NativeJobDispatchOutcome, NativeJobMutationSession,
        NativeJobStepReceipt,
    };
    use dbx_types::native_jobs::{
        NativeJobArgumentChange, NativeJobChange, NativeJobDetails, NativeJobMutation, NativeJobOperationOutcome,
    };
    async fn read_program(state: &AppState, target: &NativeJobRef, program: &str) -> NativeJobDetails {
        native_job_read_with(state, target, |query| {
            std::future::ready(program_fixture(query, "same default").map(|mut value| {
                for row in value["rows"].as_array_mut().unwrap() {
                    for cell in row.as_array_mut().unwrap() {
                        if cell == "Program,One" {
                            *cell = json!(program);
                        }
                    }
                }
                value
            }))
        })
        .await
        .unwrap()
    }
    struct Session<'a> {
        state: &'a AppState,
        calls: usize,
    }
    #[async_trait::async_trait]
    impl NativeJobMutationSession for Session<'_> {
        async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
            Ok(read_program(self.state, target, "Program,Two").await)
        }
        async fn execute(&mut self, _: &dbx_sql::native_job_changes::NativeJobSqlStep) -> NativeJobStepReceipt {
            self.calls += 1;
            NativeJobStepReceipt { outcome: NativeJobDispatchOutcome::Applied, reason: None, vendor_code: None }
        }
        async fn finish(&mut self) -> Result<(), &'static str> {
            Ok(())
        }
    }
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let initial = read_program(&state, &job, "Program,One").await;
    let plan = native_job_prepare_with(
        &state,
        NativeJobMutation {
            target: job.clone(),
            baseline: initial.snapshot.revision,
            change: NativeJobChange::Update {
                final_enabled: None,
                argument_target: None,
                attributes: vec![],
                arguments: vec![NativeJobArgumentChange {
                    position: 1,
                    value: NativeJobArgumentValue::Value { value: json!("new override for A") },
                }],
            },
        },
        |target| {
            let state = &state;
            async move { Ok(read_program(state, &target, "Program,One").await) }
        },
    )
    .await
    .unwrap();
    let mut session = Session { state: &state, calls: 0 };
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert_eq!(session.calls, 0);
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_definition_changed"));
}

#[tokio::test]
async fn anydata_number_baselines_ignore_only_decoded_locator_and_decimal_spelling_changes() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let mut reads = Vec::new();
    for (number, locator) in [
        ("9007199254740993.1200", "locator-1"),
        ("9.00719925474099312e15", "locator-2"),
        ("9007199254740993.121", "locator-2"),
    ] {
        let read = native_job_read_with(&state, &job, |query| {
            std::future::ready(if query.source.ends_with("SCHEDULER_JOB_ARGS") {
                Ok(result(
                    &[
                        "OWNER",
                        "JOB_NAME",
                        "ARGUMENT_POSITION",
                        "ARGUMENT_TYPE",
                        "VALUE",
                        "ANYDATA_VALUE",
                        "DBX_ANYDATA_PRESENT",
                        "DBX_ANYDATA_TYPE",
                        "DBX_ANYDATA_IS_NULL",
                        "DBX_ANYDATA_TEXT",
                    ],
                    json!([["Owner", "Job", 1, "NUMBER", "misleading fallback", locator, 1, "SYS.NUMBER", 0, number]]),
                ))
            } else {
                fixture(query, "41", "body", 0, "unused")
            })
        })
        .await
        .unwrap();
        let NativeJobMetadata::Available { value } = &read.snapshot.arguments else { panic!("arguments required") };
        assert!(value[0].editable);
        assert!(
            matches!(&value[0].value, NativeJobArgumentValue::Value { value } if value["typeName"] == "SYS.NUMBER")
        );
        reads.push(read);
    }
    for partition in ["argument:1", "arguments", "argument-inventory"] {
        assert!(
            state
                .native_jobs
                .compare_baseline(
                    &state,
                    &job,
                    &reads[0].snapshot.revision,
                    &reads[1].snapshot.revision,
                    &[partition],
                    false
                )
                .is_ok(),
            "{partition}"
        );
        assert_eq!(
            state.native_jobs.compare_baseline(
                &state,
                &job,
                &reads[0].snapshot.revision,
                &reads[2].snapshot.revision,
                &[partition],
                false
            ),
            Err("native_job_definition_changed"),
            "{partition}"
        );
    }
}

#[tokio::test]
async fn anydata_presence_type_and_null_evidence_control_editability_and_null_baselines() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let mut revisions = Vec::new();
    for (type_name, is_null, editable) in [
        ("SYS.NUMBER", json!(1), true),
        ("SYS.DATE", json!(1), true),
        ("APP.OBJECT", json!(0), false),
        ("SYS.NUMBER", Value::Null, false),
    ] {
        let read = native_job_read_with(&state, &job, |query| {
            std::future::ready(if query.source.ends_with("SCHEDULER_JOB_ARGS") {
                Ok(result(
                    &[
                        "OWNER",
                        "JOB_NAME",
                        "ARGUMENT_POSITION",
                        "ARGUMENT_TYPE",
                        "VALUE",
                        "ANYDATA_VALUE",
                        "DBX_ANYDATA_PRESENT",
                        "DBX_ANYDATA_TYPE",
                        "DBX_ANYDATA_IS_NULL",
                    ],
                    json!([["Owner", "Job", 1, "NUMBER", "not a fallback", "locator", 1, type_name, is_null]]),
                ))
            } else {
                fixture(query, "41", "body", 0, "unused")
            })
        })
        .await
        .unwrap();
        let NativeJobMetadata::Available { value } = &read.snapshot.arguments else { panic!("arguments required") };
        assert_eq!(value[0].editable, editable);
        if editable {
            let scalar_type = if type_name == "SYS.NUMBER" { "number" } else { "date" };
            assert!(
                value[0].value
                    == NativeJobArgumentValue::Value {
                        value: json!({"$dbx":"oracle-anydata-v1","scalarType":scalar_type,"value":null})
                    }
            );
        } else {
            assert!(matches!(value[0].value, NativeJobArgumentValue::Opaque { .. }));
        }
        revisions.push(read.snapshot.revision);
    }
    assert_eq!(
        state.native_jobs.compare_baseline(&state, &job, &revisions[0], &revisions[1], &["argument:1"], false),
        Err("native_job_definition_changed")
    );
}

#[tokio::test]
async fn civil_display_auxiliary_fields_do_not_change_the_argument_storage_baseline() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let mut revisions = Vec::new();
    for civil in [Value::Null, json!("-0001-12-31")] {
        let read = native_job_read_with(&state, &job, |query| {
            std::future::ready(if query.source.ends_with("SCHEDULER_JOB_ARGS") {
                Ok(result(
                    &[
                        "OWNER",
                        "JOB_NAME",
                        "ARGUMENT_POSITION",
                        "ARGUMENT_TYPE",
                        "VALUE",
                        "ANYDATA_VALUE",
                        "DBX_ANYDATA_PRESENT",
                        "DBX_ANYDATA_TYPE",
                        "DBX_ANYDATA_IS_NULL",
                        "DBX_ANYDATA_DAY",
                        "DBX_ANYDATA_SECONDS",
                        "DBX_ANYDATA_CIVIL_DATE",
                    ],
                    json!([[
                        "Owner",
                        "Job",
                        1,
                        "TIMESTAMP",
                        null,
                        "locator",
                        1,
                        "SYS.TIMESTAMP",
                        0,
                        "1234567",
                        "1.123456789",
                        civil
                    ]]),
                ))
            } else {
                fixture(query, "41", "body", 0, "unused")
            })
        })
        .await
        .unwrap();
        revisions.push(read.snapshot.revision);
    }
    assert_eq!(
        state.native_jobs.compare_baseline(
            &state,
            &job,
            &revisions[0],
            &revisions[1],
            &["argument:1", "arguments", "argument-inventory"],
            false
        ),
        Ok(())
    );
}

#[tokio::test]
async fn referenced_program_counts_defaults_overrides_and_metadata_arguments_are_not_inline_columns() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let read = native_job_read_with(&state, &job, |query| {
        if query.source.ends_with("SCHEDULER_PROGRAMS") || query.source.ends_with("SCHEDULER_PROGRAM_ARGS") {
            assert!(query.sql.contains("J.OWNER = 'Program.Owner'"));
            assert!(query.sql.contains("J.PROGRAM_NAME = 'Program,One'"));
        }
        std::future::ready(program_fixture(query, "default one"))
    })
    .await
    .unwrap();
    assert!(
        matches!(&read.program, Some(NativeJobMetadata::Available { value }) if value["PROGRAM_ACTION"] == "original_procedure")
    );
    let NativeJobMetadata::Available { value: args } = &read.snapshot.arguments else {
        panic!("program arguments unavailable")
    };
    assert_eq!(args.len(), 3);
    assert!(matches!(&args[0].value, NativeJobArgumentValue::Value { value } if value == "explicit override"));
    assert!(
        matches!(&args[0].default_value, Some(NativeJobMetadata::Available { value: NativeJobArgumentValue::Value { value } }) if value == "default one")
    );
    assert!(matches!(args[1].value, NativeJobArgumentValue::Inherit));
    assert!(args[1].editable);
    assert!(matches!(&args[1].default_value, Some(NativeJobMetadata::Unknown { .. })));
    assert_eq!(args[2].metadata_attribute.as_deref(), Some("JOB_NAME"));
    assert!(!args[2].editable);
    assert_eq!(read.sources["program"].source.as_deref(), Some("SYS.DBA_SCHEDULER_PROGRAMS"));
}

#[tokio::test]
async fn changed_program_defaults_invalidate_only_the_argument_baseline_they_affect() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let before =
        native_job_read_with(&state, &job, |query| std::future::ready(program_fixture(query, "before"))).await.unwrap();
    let after =
        native_job_read_with(&state, &job, |query| std::future::ready(program_fixture(query, "after"))).await.unwrap();
    assert!(state
        .native_jobs
        .compare_baseline(&state, &job, &before.snapshot.revision, &after.snapshot.revision, &["definition"], false)
        .is_ok());
    assert!(matches!(
        state.native_jobs.compare_baseline(
            &state,
            &job,
            &before.snapshot.revision,
            &after.snapshot.revision,
            &["argument:1"],
            false
        ),
        Err("native_job_definition_changed")
    ));
}

#[tokio::test]
async fn unreadable_program_metadata_keeps_the_job_definition_readable_without_inventing_zero_arguments() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let read = native_job_read_with(&state, &job, |query| {
        std::future::ready(if query.source.contains("SCHEDULER_PROGRAM") {
            Err(NativeJobCatalogFailure::Denied(Some(1031)))
        } else {
            program_fixture(query, "unused")
        })
    })
    .await
    .unwrap();
    assert!(matches!(read.snapshot.definition, NativeJobMetadata::Available { .. }));
    assert!(matches!(read.program, Some(NativeJobMetadata::Denied { .. })));
    assert!(matches!(read.snapshot.arguments, NativeJobMetadata::Unknown { .. }));
    assert!(state
        .native_jobs
        .compare_baseline(&state, &job, &read.snapshot.revision, &read.snapshot.revision, &["definition"], false)
        .is_ok());
}

#[tokio::test]
async fn oceanbase_placeholder_views_cannot_turn_a_program_with_real_arguments_into_an_empty_snapshot() {
    let (_directory, state) = state("oceanbase-oracle").await;
    let ctx = context(&state).await;
    let job = target(&ctx);
    let read = native_job_read_with(&state, &job, |query| {
        assert!(!query.source.ends_with("_ARGS"), "placeholder view must not be treated as actual parameters");
        std::future::ready(if query.source == "SYS.DBA_SCHEDULER_PROGRAM" {
            Ok(result(&["DBX_OWNER", "DBX_NAME", "NUMBER_OF_ARGUMENTS"], json!([["Program.Owner", "Program,One", 3]])))
        } else if query.source == "SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT" {
            Ok(result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "created"]])))
        } else {
            program_fixture(query, "unused")
        })
    })
    .await
    .unwrap();
    assert!(matches!(&read.program,Some(NativeJobMetadata::Available { value }) if value["NUMBER_OF_ARGUMENTS"]==3));
    assert!(matches!(read.parameter_metadata, NativeJobMetadata::Unsupported { .. }));
    assert!(matches!(read.program_arguments, Some(NativeJobMetadata::Unsupported { .. })));
    assert!(matches!(read.snapshot.arguments, NativeJobMetadata::Unsupported { .. }));
}

#[tokio::test]
async fn oceanbase_reads_effective_failure_limits_without_changing_generation_identity() {
    let (_directory, state) = state("oceanbase-oracle").await;
    let job = target(&context(&state).await);
    let read = |limit| {
        native_job_read_with(&state, &job, move |query| {
            std::future::ready(Ok(if query.source == "SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT" {
                if query.sql.contains("MAX_FAILURES") {
                    result(
                        &["DBX_JOB_ID", "DBX_CREATED_AT", "DBX_OWNER", "JOB_NAME", "MAX_FAILURES"],
                        json!([["41", "created", "Owner", "Job", limit]]),
                    )
                } else {
                    result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "created"]]))
                }
            } else if query.source.ends_with("SCHEDULER_JOBS") {
                result(
                    &["OWNER", "JOB_NAME", "MAX_FAILURES", "MAX_RUN_DURATION", "NUMBER_OF_ARGUMENTS"],
                    json!([["Owner", "Job", null, "+000 00:02:00", 0]]),
                )
            } else {
                result(&["JOB_NAME"], json!([]))
            }))
        })
    };
    let before = read(2).await.unwrap();
    let after = read(3).await.unwrap();
    assert!(matches!(&before.snapshot.definition, NativeJobMetadata::Available { value } if value["MAX_FAILURES"]==2));
    assert!(matches!(&after.snapshot.definition, NativeJobMetadata::Available { value } if value["MAX_FAILURES"]==3));
    assert!(
        matches!(&before.native_identity, NativeJobMetadata::Available { value } if !value.contains_key("MAX_FAILURES"))
    );
    assert!(state
        .native_jobs
        .compare_baseline(&state, &job, &before.snapshot.revision, &after.snapshot.revision, &[], false)
        .is_ok());
    assert!(matches!(
        state.native_jobs.compare_baseline(
            &state,
            &job,
            &before.snapshot.revision,
            &after.snapshot.revision,
            &["definition"],
            false
        ),
        Err("native_job_definition_changed")
    ));
}

#[tokio::test]
async fn unavailable_or_wrong_identity_native_limits_do_not_become_null_or_hide_other_fields() {
    let (_directory, state) = state("oceanbase-oracle").await;
    let job = target(&context(&state).await);
    for denied in [false, true] {
        let read = native_job_read_with(&state, &job, |query| {
            std::future::ready(if query.source == "SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT" {
                if query.sql.contains("MAX_FAILURES") {
                    if denied {
                        Err(NativeJobCatalogFailure::Denied(Some(1031)))
                    } else {
                        Ok(result(
                            &["DBX_JOB_ID", "DBX_CREATED_AT", "DBX_OWNER", "JOB_NAME", "MAX_FAILURES"],
                            json!([["42", "replaced", "Owner", "Job", 2]]),
                        ))
                    }
                } else {
                    Ok(result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", "created"]])))
                }
            } else if query.source.ends_with("SCHEDULER_JOBS") {
                Ok(result(
                    &["OWNER", "JOB_NAME", "MAX_FAILURES", "MAX_RUN_DURATION", "NUMBER_OF_ARGUMENTS"],
                    json!([["Owner", "Job", null, "+000 00:02:00", 0]]),
                ))
            } else {
                Ok(result(&["JOB_NAME"], json!([])))
            })
        })
        .await
        .unwrap();
        assert!(
            matches!(&read.snapshot.definition, NativeJobMetadata::Available { value } if !value.contains_key("MAX_FAILURES") && value["MAX_RUN_DURATION"]=="+000 00:02:00")
        );
        assert!(state
            .native_jobs
            .compare_baseline(&state, &job, &read.snapshot.revision, &read.snapshot.revision, &["definition"], false)
            .is_ok());
    }
}

#[tokio::test]
async fn baselines_ignore_natural_runtime_progress_but_detect_changed_definitions_and_replacements() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let a =
        native_job_read_with(&state, &job, |query| std::future::ready(fixture(query, "41", "first", 0, "opaque-a")))
            .await
            .unwrap();
    let b =
        native_job_read_with(&state, &job, |query| std::future::ready(fixture(query, "41", "first", 1, "opaque-b")))
            .await
            .unwrap();
    assert!(state
        .native_jobs
        .compare_baseline(
            &state,
            &job,
            &a.snapshot.revision,
            &b.snapshot.revision,
            &["definition", "argument:1"],
            false
        )
        .is_ok());
    assert!(matches!(
        state.native_jobs.compare_baseline(
            &state,
            &job,
            &a.snapshot.revision,
            &b.snapshot.revision,
            &["argument:2"],
            false
        ),
        Err("native_job_metadata_incomplete")
    ));
    let c = native_job_read_with(&state, &job, |query| {
        std::future::ready(fixture(query, "41", "changed body", 1, "opaque-b"))
    })
    .await
    .unwrap();
    assert!(matches!(
        state.native_jobs.compare_baseline(
            &state,
            &job,
            &b.snapshot.revision,
            &c.snapshot.revision,
            &["definition"],
            false
        ),
        Err("native_job_definition_changed")
    ));
    let replaced = native_job_read_with(&state, &job, |query| {
        std::future::ready(fixture(query, "42", "changed body", 1, "opaque-b"))
    })
    .await
    .unwrap();
    assert!(matches!(
        state.native_jobs.compare_baseline(&state, &job, &c.snapshot.revision, &replaced.snapshot.revision, &[], false),
        Err("native_job_replaced")
    ));
}

#[tokio::test]
async fn stable_temporal_text_keeps_definition_baselines_but_changed_dates_are_rejected() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let mut previous = None;
    for date in [
        "2032-01-01 23:54:25.123456789 +5:30",
        "2032-01-01 23:54:25.123456789 +5:30",
        "2032-01-01 23:54:25.123456788 +5:30",
    ] {
        let details = native_job_read_with(&state, &job, |query| {
            let definition = query.source.ends_with("SCHEDULER_JOBS");
            let value = fixture(query, "41", "same body", 0, "opaque").map(|mut value| {
                if definition {
                    value["columns"].as_array_mut().unwrap().push(json!("START_DATE"));
                    value["rows"][0].as_array_mut().unwrap().push(json!(date));
                }
                value
            });
            std::future::ready(value)
        })
        .await
        .unwrap();
        if let Some(previous) = previous.as_deref() {
            assert_eq!(
                state.native_jobs.compare_baseline(
                    &state,
                    &job,
                    previous,
                    &details.snapshot.revision,
                    &["definition"],
                    false
                ),
                if date.ends_with("789 +5:30") { Ok(()) } else { Err("native_job_definition_changed") }
            );
        }
        previous = Some(details.snapshot.revision.clone());
    }
}

#[tokio::test]
async fn replacement_during_details_read_keeps_the_readable_data_but_cannot_authorize_a_write() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let mut generations = 0;
    let read = native_job_read_with(&state, &job, |query| {
        if query.source.ends_with("_OBJECTS") {
            generations += 1;
        }
        std::future::ready(fixture(query, if generations > 1 { "42" } else { "41" }, "readable", 0, "opaque"))
    })
    .await
    .unwrap();
    assert!(
        matches!(&read.consistency, NativeJobMetadata::Error { reason } if reason == "native_job_replaced_during_read")
    );
    assert!(
        matches!(&read.snapshot.definition, NativeJobMetadata::Available { value } if value["JOB_ACTION"] == "readable")
    );
    assert!(matches!(
        state.native_jobs.compare_baseline(&state, &job, &read.snapshot.revision, &read.snapshot.revision, &[], false),
        Err("native_job_identity_unverified")
    ));
}

#[tokio::test]
async fn invalidation_cancels_an_inflight_read_without_recording_a_late_baseline() {
    let (_directory, state) = state("oracle").await;
    let job = target(&context(&state).await);
    let (entered, mut started) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let mut read = Box::pin(native_job_read_with(&state, &job, |_| {
        entered.take().unwrap().send(()).unwrap();
        std::future::pending::<Result<Value, NativeJobCatalogFailure>>()
    }));
    tokio::select! { result = &mut read => { assert!(result.is_err()); panic!("read ended before invalidation"); }, _ = &mut started => {} }
    state.invalidate_connection_lifecycle("connection");
    assert!(matches!(read.await, Err("native_job_context_changed")));
}
