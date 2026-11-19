use super::*;
use crate::models::connection::{ConnectionConfig, DatabaseType};

#[tokio::test]
async fn owned_session_list_retains_unresolved_operation_identity_and_request_generation() {
    let fixture = Fixture::new("results_normal").await;
    let access = PlDebugAccess::web("recovery-owner".into()).unwrap();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("recovery-start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "recovery-start").await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    {
        let mut data = entry.lock();
        let template = data.operations["recovery-start"].receipt.clone();
        data.active_operation = None;
        data.close_operation = Some("original-close".into());
        for (serial, id, action, state, request_generation, receipt_generation) in [
            (2, "unknown-write", PlDebugAction::SetValue, OperationState::Unknown, 1, 1),
            (3, "accepted-close", PlDebugAction::Close, OperationState::Accepted, 1, 1),
            (4, "running-restart", PlDebugAction::Restart, OperationState::Running, 1, 2),
            (5, "finished-write", PlDebugAction::SetValue, OperationState::Succeeded, 1, 1),
        ] {
            let mut receipt = template.clone();
            receipt.operation_id = id.into();
            receipt.state = state;
            receipt.generation = receipt_generation;
            data.operations.insert(id.into(), Operation {
                request: json!({"generation": request_generation, "params": {"privateValue": "must-not-be-projected"}}),
                receipt,
                control_serial: serial,
                action: Some(action),
                breakpoint_receipts: false,
                execute_receipts: false,
                effective_stop_revision: None,
            });
        }
    }
    let listed =
        pl_debug_list_core(&fixture.state, &access, fixture.state.pl_debug.epoch, &reference.connection_id).unwrap();
    assert_eq!(listed.len(), 1);
    let recovery = &listed[0]["recovery"];
    assert_eq!(recovery["version"], 1);
    assert_eq!(recovery["closeOperationId"], "original-close");
    assert_eq!(recovery["operations"].as_array().unwrap().len(), 3);
    assert_eq!(recovery["operations"][0]["operationId"], "unknown-write");
    assert_eq!(recovery["operations"][2]["requestGeneration"], 1);
    assert_eq!(recovery["operations"][2]["receiptGeneration"], 2);
    assert!(!recovery.to_string().contains("must-not-be-projected"));
    let foreign = PlDebugAccess::web("other-recovery-owner".into()).unwrap();
    assert!(pl_debug_list_core(&fixture.state, &foreign, fixture.state.pl_debug.epoch, &reference.connection_id)
        .unwrap()
        .is_empty());
    {
        let mut data = entry.lock();
        data.operations.retain(|id, _| id == "recovery-start");
        data.close_operation = None;
    }
    fixture.close(&access, &reference).await;
}

fn result_request(
    reference: &PlDebugSessionRef,
    generation: u64,
    page: bool,
    offset: usize,
    limit: usize,
) -> PlDebugRead {
    PlDebugRead {
        session: reference.clone(),
        generation,
        stop_revision: None,
        kind: if page { PlDebugReadKind::ResultPage } else { PlDebugReadKind::Results },
        params: if page {
            json!({"generation":"fixture-generation","resultId":"fixture-result","offset":offset,"limit":limit})
        } else {
            json!({})
        },
    }
}

#[tokio::test]
async fn retained_results_survive_process_exit_restart_and_enforce_original_access() {
    let fixture = Fixture::new("results_normal").await;
    let access = PlDebugAccess::web("result-owner".into()).unwrap();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("result-start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "result-start").await;
    fixture.close(&access, &reference).await;
    assert!(fixture.state.pl_debug.find(&access, &reference).unwrap().lock().runtime_exited);
    let manifest =
        pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, false, 0, 0)).await.unwrap();
    assert_eq!(manifest["retentionState"], "complete");
    assert_eq!(manifest["results"][0]["missingRanges"], json!([]));
    let first = pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 0, 20)).await.unwrap();
    let original = first["data"].as_str().unwrap().to_owned();
    let tail =
        pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 65535, 6)).await.unwrap();
    assert_eq!(tail["data"], "😀tail");
    let reads = fixture.count("pl_debug_get_result_page");
    let foreign = PlDebugAccess::web("other-result-owner".into()).unwrap();
    assert!(pl_debug_read_core(&fixture.state, &foreign, result_request(&reference, 1, true, 0, 20)).await.is_err());
    for field in ["client", "connection"] {
        let mut wrong = reference.clone();
        if field == "client" {
            wrong.client_session_id = "other-client".into();
        } else {
            wrong.connection_id = "other-connection".into();
        }
        assert!(pl_debug_read_core(&fixture.state, &access, result_request(&wrong, 1, true, 0, 20)).await.is_err());
    }
    let mut wrong = result_request(&reference, 1, true, 0, 20);
    wrong.params["resultId"] = json!("other-result");
    assert!(pl_debug_read_core(&fixture.state, &access, wrong).await.is_err());
    assert_eq!(fixture.count("pl_debug_get_result_page"), reads);
    let restart = fixture.operation(&access, &reference, "result-restart", PlDebugAction::Restart).await;
    pl_debug_operate_core(&fixture.state, &access, restart).await.unwrap();
    fixture.receipt(&access, &reference, "result-restart").await;
    assert_eq!(
        pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 0, 20)).await.unwrap()["data"],
        original
    );
    assert_eq!(fixture.count("pl_debug_get_result_page"), reads);
    let close = fixture.operation(&access, &reference, "close-result-restarted", PlDebugAction::Close).await;
    pl_debug_operate_core(&fixture.state, &access, close).await.unwrap();
    fixture.receipt(&access, &reference, "close-result-restarted").await;
    let current =
        pl_debug_read_core(&fixture.state, &access, result_request(&reference, 2, true, 0, 20)).await.unwrap();
    assert_ne!(current["data"], original);
    assert_eq!(
        pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 0, 20)).await.unwrap()["data"],
        original
    );
    assert_eq!(fixture.count("business_dispatch"), 2);
}

#[tokio::test]
async fn retained_results_keep_confirmed_pages_when_manifest_page_or_process_fails() {
    for mode in ["results_page_fail", "results_manifest_fail", "results_early_exit"] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("result-failure")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "result-failure").await;
        fixture.close(&access, &reference).await;
        let status = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
        assert_eq!(status["releaseState"], "released", "{status}");
        assert!(status["resultRetentionError"].is_string(), "{status}");
        let manifest = pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, false, 0, 0)).await;
        if mode == "results_page_fail" {
            let manifest = manifest.unwrap();
            assert_eq!(manifest["retentionState"], "partial");
            assert_eq!(manifest["results"][0]["missingRanges"], json!([{"offset":65535,"nextOffset":65541}]));
            assert_eq!(
                pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 0, 16)).await.unwrap()
                    ["nextOffset"],
                16
            );
            assert!(pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 65535, 6))
                .await
                .is_err());
        } else {
            assert!(manifest.is_err());
        }
        let log = pl_debug_read_core(
            &fixture.state,
            &access,
            PlDebugRead {
                session: reference.clone(),
                generation: 1,
                stop_revision: None,
                kind: PlDebugReadKind::Log,
                params: json!({}),
            },
        )
        .await
        .unwrap();
        assert_eq!(log["output"], "one\n\n中😀*|\\\n");
        assert_eq!(fixture.count("business_dispatch"), 1);
        assert_eq!(fixture.count("pl_debug_get_results"), 1);
    }
}

#[tokio::test]
async fn retained_results_shortened_deadline_preserves_database_release_and_cached_prefix() {
    let fixture = Fixture::new("results_page_hold").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("result-deadline")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "result-deadline").await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    request_close(&entry, "client_close", Instant::now() + Duration::from_secs(60));
    fixture.wait_event("result_page_wait").await;
    request_close(&entry, "application_shutdown", Instant::now() + Duration::from_millis(100));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !entry.lock().runtime_exited {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let snapshot = entry.lock().snapshot.clone();
    assert_eq!(snapshot["releaseState"], "released");
    assert_eq!(snapshot["executionOutcome"], "cancelled");
    assert_eq!(snapshot["resultRetentionState"], "partial");
    assert!(snapshot.get("controllerLossRisk").is_none());
    assert!(snapshot["resultRetentionError"].as_str().unwrap().contains("deadline"));
    assert_eq!(
        pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 0, 16)).await.unwrap()
            ["nextOffset"],
        16
    );
    assert!(pl_debug_read_core(&fixture.state, &access, result_request(&reference, 1, true, 65535, 6)).await.is_err());
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[tokio::test]
async fn retained_results_immutable_page_read_is_not_invalidated_by_a_new_control_serial() {
    let fixture = Fixture::new("results_read_hold").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("result-live")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "result-live").await;
    let state = fixture.state.clone();
    let owner = access.clone();
    let request = result_request(&reference, 1, true, 0, 16);
    let read = tokio::spawn(async move { pl_debug_read_core(&state, &owner, request).await });
    fixture.wait_event("result_page_wait").await;
    let step = fixture.operation(&access, &reference, "step-with-result-read", PlDebugAction::StepOver).await;
    pl_debug_operate_core(&fixture.state, &access, step).await.unwrap();
    fixture.receipt(&access, &reference, "step-with-result-read").await;
    fixture.release("result-page-gate");
    assert_eq!(read.await.unwrap().unwrap()["nextOffset"], 16);
    fixture.close(&access, &reference).await;
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[tokio::test]
async fn admission_shutdown_and_start_capacity_reject_without_consuming_an_identity() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    fixture.state.pl_debug.lock().accepting = false;
    let error = pl_debug_start_submission_core(&fixture.state, &access, fixture.start_request("shutdown-rejection"))
        .err()
        .unwrap();
    assert_eq!(error.into_backend_error().code(), "DBX-PLDEBUG-1001");
    {
        let mut registry = fixture.state.pl_debug.lock();
        assert!(registry.starts.is_empty());
        registry.accepting = true;
        for index in 0..MAX_START_IDENTITIES {
            registry.starts.insert((access.owner.clone(), format!("retained-{index}")), None);
        }
    }
    let error = pl_debug_start_submission_core(&fixture.state, &access, fixture.start_request("capacity-rejection"))
        .err()
        .unwrap();
    assert_eq!(error.into_backend_error().code(), "DBX-PLDEBUG-1001");
    assert_eq!(fixture.state.pl_debug.lock().starts.len(), MAX_START_IDENTITIES);
    assert!(fixture.state.pl_debug.lock().sessions.is_empty());
    assert_eq!(fixture.count("business_dispatch"), 0);
}

#[tokio::test]
async fn admission_close_alias_returns_only_the_original_close_owner_receipt() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("close-alias-start")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&access, &reference, "close-alias-start").await;
    fixture.close(&access, &reference).await;
    let request = fixture.operation(&access, &reference, "new-close-alias", PlDebugAction::Close).await;
    let receipt = pl_debug_operate_submission_core(&fixture.state, &access, request.clone()).await.unwrap();
    assert_eq!(receipt.operation_id, "close-fixture");
    assert_eq!(receipt.generation, request.generation);
    assert_eq!(receipt.session_id, reference.session_id);
    assert!(matches!(receipt.state, OperationState::Succeeded));
    assert!(pl_debug_operation_core(&fixture.state, &access, &reference, "new-close-alias").is_err());
    assert_eq!(fixture.count("pl_debug_close"), 1);
}

#[tokio::test]
async fn admission_start_rejection_is_proven_only_for_a_new_authorized_identity() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let mut request = fixture.start_request("admission-start");
    request.expected_connection_revision = Some("stale-preview".into());
    let error = pl_debug_start_submission_core(&fixture.state, &access, request.clone()).err().unwrap();
    let envelope = error.into_backend_error();
    assert_eq!(envelope.code(), "DBX-PLDEBUG-1001");
    assert_eq!(envelope.operation_outcome(), crate::backend_error::BackendOperationOutcome::NotStarted);
    assert!(fixture.state.pl_debug.lock().starts.is_empty());
    assert_eq!(fixture.count("business_dispatch"), 0);
    request.expected_connection_revision = None;
    let started = pl_debug_start_submission_core(&fixture.state, &access, request.clone()).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&access, &reference, "admission-start").await;
    let duplicate = pl_debug_start_submission_core(&fixture.state, &access, request.clone()).unwrap();
    assert_eq!(duplicate.session_id, started.session_id);
    request.target = json!(null);
    assert!(matches!(
        pl_debug_start_submission_core(&fixture.state, &access, request),
        Err(PlDebugSubmissionError::Unresolved(_))
    ));
    assert_eq!(fixture.count("business_dispatch"), 1);
    fixture.close(&access, &reference).await;
    fixture.state.pl_debug.lock().starts.insert((access.owner.clone(), "expired-start".into()), None);
    assert!(matches!(
        pl_debug_start_submission_core(&fixture.state, &access, fixture.start_request("expired-start")),
        Err(PlDebugSubmissionError::Unresolved(_))
    ));
    let mut wrong_epoch = fixture.start_request("wrong-epoch");
    wrong_epoch.server_epoch = Uuid::new_v4();
    assert!(matches!(
        pl_debug_start_submission_core(&fixture.state, &access, wrong_epoch),
        Err(PlDebugSubmissionError::Unresolved(_))
    ));
}

#[tokio::test]
async fn admission_control_rejects_without_registering_but_preserves_conflicts_and_access_errors() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let started =
        pl_debug_start_core(&fixture.state, &access, fixture.start_request("admission-control-start")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&access, &reference, "admission-control-start").await;
    let mut request = fixture.operation(&access, &reference, "admission-control", PlDebugAction::StepOver).await;
    request.expected_revision += 10;
    let error = pl_debug_operate_submission_core(&fixture.state, &access, request.clone()).await.err().unwrap();
    assert_eq!(error.into_backend_error().code(), "DBX-PLDEBUG-1001");
    assert!(pl_debug_operation_core(&fixture.state, &access, &reference, "admission-control").is_err());
    assert_eq!(fixture.count("pl_debug_step_over"), 0);
    request = fixture.operation(&access, &reference, "admission-control", PlDebugAction::StepOver).await;
    pl_debug_operate_submission_core(&fixture.state, &access, request.clone()).await.unwrap();
    fixture.receipt(&access, &reference, "admission-control").await;
    request.params = json!({"different":true});
    assert!(matches!(
        pl_debug_operate_submission_core(&fixture.state, &access, request.clone()).await,
        Err(PlDebugSubmissionError::Unresolved(_))
    ));
    let other = PlDebugAccess::web("other".into()).unwrap();
    assert!(matches!(
        pl_debug_operate_submission_core(&fixture.state, &other, request).await,
        Err(PlDebugSubmissionError::Unresolved(_))
    ));
    assert_eq!(fixture.count("pl_debug_step_over"), 1);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn admission_duplicate_accepted_during_write_guard_wait_wins_over_the_late_rejection() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("admission-race-start")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&access, &reference, "admission-race-start").await;
    let request = fixture.operation(&access, &reference, "admission-race", PlDebugAction::StepOver).await;
    fixture.state.configs.write().await.get_mut("conn").unwrap().read_only = true;
    let guard = fixture.state.write_unlock_windows.hold_lock_for_test().await;
    let mut first = Box::pin(pl_debug_operate_submission_core(&fixture.state, &access, request.clone()));
    assert!(futures::poll!(&mut first).is_pending());
    fixture.state.configs.write().await.get_mut("conn").unwrap().read_only = false;
    let accepted = pl_debug_operate_submission_core(&fixture.state, &access, request).await.unwrap();
    drop(guard);
    let duplicate = first.await.unwrap();
    assert_eq!(duplicate.operation_id, accepted.operation_id);
    assert_eq!(duplicate.session_id, accepted.session_id);
    fixture.receipt(&access, &reference, "admission-race").await;
    assert_eq!(fixture.count("pl_debug_step_over"), 1);
    fixture.close(&access, &reference).await;
}

#[test]
fn admission_boundary_string_preserves_the_catalog_but_legacy_api_messages_stay_plain() {
    let error = PlDebugSubmissionError::RejectedBeforeRegistration("stale revision".into());
    let envelope: Value = serde_json::from_str(&error.into_boundary_string()).unwrap();
    assert_eq!(envelope["code"], "DBX-PLDEBUG-1001");
    assert_eq!(envelope["operationOutcome"], "not_started");
    assert_eq!(envelope["origin"], json!({"subsystem":"backend","adapter":"legacy"}));
    assert_eq!(
        PlDebugSubmissionError::Unresolved("original failure".into()).into_boundary_string(),
        "original failure"
    );
    assert_eq!(
        PlDebugSubmissionError::RejectedBeforeRegistration("stale revision".into()).into_legacy_message(),
        "stale revision"
    );
}

async fn accepted_connection_change<T>(state: &AppState, operation: impl std::future::Future<Output = T>) -> T {
    let permit = pl_debug_claim_mutation_core(
        state,
        Some(&PlDebugAccess::desktop()),
        PlDebugMutationScope::Connections(vec!["conn".into()]),
    )
    .unwrap();
    permit.after_debug_cleanup(async { Ok(operation.await) }).await.unwrap()
}

#[tokio::test]
async fn transport_reset_without_accepted_actor_keeps_protected_debugger_untouched() {
    let fixture = Fixture::new("normal").await;
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("unclaimed-reset")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&owner, &reference, "unclaimed-reset").await;
    let config = fixture.state.configs.read().await.get("conn").unwrap().clone();
    let original = current_transport(&fixture.state, "conn").unwrap();
    fixture.state.reset_connection_transport_for_config("conn", &config).await;
    let close_count = fixture.count("pl_debug_close");
    let exit_count = fixture.count("process_exit");
    let same_transport = current_transport(&fixture.state, "conn").is_some_and(|current| current.same_token(&original));
    fixture.close(&owner, &reference).await;
    assert_eq!(close_count, 0, "missing actor was treated as permission to close the protected debugger");
    assert_eq!(exit_count, 0, "unclaimed reset terminated another owner's runtime");
    assert!(same_transport, "unclaimed reset retired the protected original transport");
}

#[tokio::test]
async fn transport_forwarded_reconnect_propagates_missing_actor_without_mutating_the_original_pool() {
    let fixture = Fixture::new("normal").await;
    {
        let mut configs = fixture.state.configs.write().await;
        let config = configs.get_mut("conn").unwrap();
        config.transport_layers = serde_json::from_value(json!([
            {"type":"proxy","id":"proxy","host":"127.0.0.1","port":config.port}
        ]))
        .unwrap();
    }
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("unclaimed-reconnect")).unwrap();
    let reference = fixture.reference(&started);
    assert!(matches!(
        fixture.receipt(&owner, &reference, "unclaimed-reconnect").await.state,
        OperationState::Succeeded
    ));
    fixture.idle_query_pool().await;
    let Some(crate::connection::PoolKind::Sqlite(pool)) = fixture.state.pool_handle("conn").await else {
        panic!("missing original query pool");
    };
    pool.with_connection(|connection| {
        connection
            .execute_batch(
                "CREATE TABLE original_pool_marker(value INTEGER); INSERT INTO original_pool_marker VALUES(17)",
            )
            .map_err(|error| error.to_string())
    })
    .unwrap();
    let original = current_transport(&fixture.state, "conn").unwrap();
    let result = fixture.state.reconnect_pool("conn", None).await;
    let closes = fixture.count("pl_debug_close");
    let same_transport = current_transport(&fixture.state, "conn").is_some_and(|current| current.same_token(&original));
    let original_pool_preserved = match fixture.state.pool_handle("conn").await {
        Some(crate::connection::PoolKind::Sqlite(pool)) => {
            pool.with_connection(|connection| {
                connection
                    .query_row("SELECT value FROM original_pool_marker", [], |row| row.get::<_, i64>(0))
                    .map_err(|error| error.to_string())
            }) == Ok(17)
        }
        _ => false,
    };
    fixture.close(&owner, &reference).await;
    assert!(
        result.as_ref().is_err_and(|error| error.contains("not allowed while a protected debugger is active")),
        "forwarded reconnect swallowed the cleanup refusal: {result:?}"
    );
    assert_eq!(closes, 0);
    assert!(same_transport);
    assert!(original_pool_preserved);
}

#[tokio::test]
async fn transport_accepted_mutation_is_not_inherited_by_a_spawned_cleanup_task() {
    let fixture = Fixture::new("normal").await;
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("spawned-reset")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&owner, &reference, "spawned-reset").await;
    let original = current_transport(&fixture.state, "conn").unwrap();
    let permit = pl_debug_claim_mutation_core(
        &fixture.state,
        Some(&owner),
        PlDebugMutationScope::Connections(vec!["conn".into()]),
    )
    .unwrap();
    permit
        .after_debug_cleanup(async {
            let state = fixture.state.clone();
            tokio::spawn(async move { state.reset_connection_transport("conn").await }).await.unwrap();
            assert!(
                current_transport(&fixture.state, "conn").is_some_and(|current| current.same_token(&original)),
                "spawned task inherited permission to retire the retained original transport"
            );
            fixture.state.reset_connection_transport("conn").await;
            assert!(current_transport(&fixture.state, "conn").is_none());
            Ok(())
        })
        .await
        .unwrap();
    drop(permit);
    fixture.close(&owner, &reference).await;
    assert_eq!(fixture.count("pl_debug_close"), 1);
}

#[tokio::test]
async fn transport_forwarded_reconnect_with_accepted_owner_replaces_the_original_runtime() {
    let fixture = Fixture::new("normal").await;
    {
        let mut configs = fixture.state.configs.write().await;
        let config = configs.get_mut("conn").unwrap();
        config.transport_layers = serde_json::from_value(json!([
            {"type":"proxy","id":"proxy","host":"127.0.0.1","port":config.port}
        ]))
        .unwrap();
    }
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("accepted-reconnect")).unwrap();
    let reference = fixture.reference(&started);
    assert!(matches!(fixture.receipt(&owner, &reference, "accepted-reconnect").await.state, OperationState::Succeeded));
    fixture.idle_query_pool().await;
    let original = current_transport(&fixture.state, "conn").unwrap();
    let permit = pl_debug_claim_mutation_core(
        &fixture.state,
        Some(&owner),
        PlDebugMutationScope::Connections(vec!["conn".into()]),
    )
    .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        permit.after_debug_cleanup(fixture.state.reconnect_pool("conn", None)),
    )
    .await;
    let replaced = current_transport(&fixture.state, "conn").is_some_and(|current| !current.same_runtime(&original));
    let has_pool = fixture.state.pool_handle("conn").await.is_some();
    drop(permit);
    fixture.state.shutdown(Duration::from_secs(1)).await;
    assert!(matches!(result, Ok(Ok(_))), "accepted reconnect did not complete under its original gate: {result:?}");
    assert!(replaced, "accepted reconnect retained the old physical transport");
    assert!(has_pool, "accepted reconnect did not publish its replacement pool");
    assert_eq!(fixture.count("pl_debug_close"), 1);
}

#[tokio::test]
async fn transport_accepted_mutation_reuses_its_original_gate_for_nested_reset() {
    let fixture = Fixture::new("normal").await;
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("nested-accepted-reset")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&owner, &reference, "nested-accepted-reset").await;
    let config = fixture.state.configs.read().await.get("conn").unwrap().clone();
    let permit = pl_debug_claim_mutation_core(
        &fixture.state,
        Some(&owner),
        PlDebugMutationScope::Connections(vec!["conn".into()]),
    )
    .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        permit.after_debug_cleanup(async {
            fixture.state.reset_connection_transport_for_config("conn", &config).await;
            Ok(())
        }),
    )
    .await;
    let retired = current_transport(&fixture.state, "conn").is_none();
    drop(permit);
    fixture.close(&owner, &reference).await;
    assert!(matches!(result, Ok(Ok(()))), "accepted nested reset waited for its own cleanup gate: {result:?}");
    assert!(retired, "nested reset returned without actually retiring the original transport");
    assert_eq!(fixture.count("pl_debug_close"), 1);
}

#[tokio::test]
async fn mutation_admission_blocks_new_starts_until_all_accepted_changes_finish_without_consuming_start_ids() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let first =
        pl_debug_claim_mutation_core(&fixture.state, None, PlDebugMutationScope::Connections(vec!["conn".into()]))
            .unwrap();
    let second =
        pl_debug_claim_mutation_core(&fixture.state, None, PlDebugMutationScope::Connections(vec!["conn".into()]))
            .unwrap();
    assert!(pl_debug_start_core(&fixture.state, &access, fixture.start_request("mutation-start")).is_err());
    drop(first);
    assert!(pl_debug_start_core(&fixture.state, &access, fixture.start_request("mutation-start")).is_err());
    drop(second);
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("mutation-start")).unwrap();
    let reference = fixture.reference(&started);
    let receipt = fixture.receipt(&access, &reference, "mutation-start").await;
    assert!(matches!(receipt.state, OperationState::Succeeded));
    assert_eq!(fixture.count("business_dispatch"), 1);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn mutation_admission_checks_pending_starts_and_rejects_entire_cross_owner_scope_before_cleanup() {
    let fixture = Fixture::new("normal").await;
    let first = PlDebugAccess::web("first".into()).unwrap();
    let second = PlDebugAccess::web("second".into()).unwrap();
    pl_debug_start_core(&fixture.state, &first, fixture.start_request("pending-mutation")).unwrap();
    for access in [None, Some(&second)] {
        assert!(pl_debug_claim_mutation_core(
            &fixture.state,
            access,
            PlDebugMutationScope::Connections(vec!["unrelated".into(), "conn".into()]),
        )
        .is_err());
        assert!(pl_debug_claim_mutation_core(&fixture.state, access, PlDebugMutationScope::Driver("oracle".into()),)
            .is_err());
        assert!(pl_debug_claim_mutation_core(
            &fixture.state,
            access,
            PlDebugMutationScope::TunnelProfiles(vec!["profile".into()])
        )
        .is_err());
    }
    assert!(fixture.state.pl_debug.lock().mutation_permits.is_empty());
    assert_eq!(fixture.count("pl_debug_close"), 0);
    let permit = pl_debug_claim_mutation_core(&fixture.state, Some(&first), PlDebugMutationScope::AllRuntimes).unwrap();
    permit.after_debug_cleanup(async { Ok(()) }).await.unwrap();
    assert_eq!(fixture.count("business_dispatch"), 0);
    drop(permit);
    assert!(pl_debug_claim_mutation_core(&fixture.state, None, PlDebugMutationScope::AllRuntimes).is_ok());
}

#[tokio::test]
async fn profile_mutation_blocks_matching_preparation_before_hydration_but_not_unrelated_starts() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let permit = pl_debug_claim_mutation_core(
        &fixture.state,
        None,
        PlDebugMutationScope::TunnelProfiles(vec!["blocked".into()]),
    )
    .unwrap();
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("unrelated-profile")).unwrap();
    let reference = fixture.reference(&started);
    let receipt = fixture.receipt(&access, &reference, "unrelated-profile").await;
    assert!(matches!(receipt.state, OperationState::Succeeded));
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.id = "blocked-connection".into();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"reference","profile_id":"blocked","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    fixture.state.configs.write().await.insert(config.id.clone(), config);
    let mut request = fixture.start_request("blocked-profile");
    request.connection_id = "blocked-connection".into();
    let blocked = pl_debug_start_core(&fixture.state, &access, request).unwrap();
    let mut blocked_ref = fixture.reference(&blocked);
    blocked_ref.connection_id = "blocked-connection".into();
    let receipt = fixture.receipt(&access, &blocked_ref, "blocked-profile").await;
    assert!(matches!(receipt.state, OperationState::Failed));
    assert!(receipt.error.unwrap().to_string().contains("being changed"));
    assert_eq!(fixture.count("business_dispatch"), 1);
    assert_eq!(fixture.count("pl_debug_close"), 0);
    drop(permit);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn profile_mutation_cannot_drain_another_owners_different_source_on_the_same_connection() {
    let fixture = Fixture::new("normal").await;
    let profiles = ["first-profile", "second-profile"].map(|id| {
        serde_json::from_value(json!({
            "type":"proxy","id":id,"host":"127.0.0.1","port":65000
        }))
        .unwrap()
    });
    fixture.state.storage.save_tunnel_profiles(&profiles).await.unwrap();
    let first = PlDebugAccess::web("first".into()).unwrap();
    let second = PlDebugAccess::web("second".into()).unwrap();
    let mut references = Vec::new();
    for (index, owner) in [&first, &second].into_iter().enumerate() {
        let mut layer = serde_json::to_value(&profiles[index]).unwrap();
        layer["profile_id"] = json!(profiles[index].id());
        layer["id"] = json!("reference");
        fixture.state.configs.write().await.get_mut("conn").unwrap().transport_layers =
            vec![serde_json::from_value(layer).unwrap()];
        let id = format!("profile-start-{index}");
        let started = pl_debug_start_core(&fixture.state, owner, fixture.start_request(&id)).unwrap();
        let reference = fixture.reference(&started);
        let receipt = fixture.receipt(owner, &reference, &id).await;
        assert!(matches!(receipt.state, OperationState::Succeeded));
        references.push(reference);
    }
    assert!(pl_debug_claim_mutation_core(
        &fixture.state,
        Some(&first),
        PlDebugMutationScope::TunnelProfiles(vec!["first-profile".into()])
    )
    .is_err());
    assert_eq!(fixture.count("pl_debug_close"), 0);
    fixture.close(&first, &references[0]).await;
    fixture.close(&second, &references[1]).await;
}

#[tokio::test]
async fn runtime_mutation_keeps_admission_closed_through_actual_cleanup_and_protected_manager_operation() {
    let fixture = Fixture::new("close_delay").await;
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("runtime-mutation")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&owner, &reference, "runtime-mutation").await;
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
    let app = fixture.state.clone();
    let task_owner = owner.clone();
    let mutation = tokio::spawn(async move {
        let permit =
            pl_debug_claim_mutation_core(&app, Some(&task_owner), PlDebugMutationScope::Driver("oracle".into()))
                .unwrap();
        permit
            .after_debug_cleanup(async {
                entered_tx.send(()).unwrap();
                finish_rx.await.unwrap();
                app.agent_manager.stop_daemon_by_key("oracle").await;
                Ok(())
            })
            .await
    });
    fixture.wait_event("close_entered").await;
    assert_eq!(fixture.count("process_exit"), 0);
    assert_eq!(fixture.state.agent_manager.connection_runtimes.lock().await.len(), 1);
    assert!(pl_debug_start_core(&fixture.state, &owner, fixture.start_request("after-runtime-mutation")).is_err());
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(10), entered_rx).await.unwrap().unwrap();
    assert_eq!(fixture.count("process_exit"), 1);
    assert!(pl_debug_start_core(&fixture.state, &owner, fixture.start_request("after-runtime-mutation")).is_err());
    finish_tx.send(()).unwrap();
    mutation.await.unwrap().unwrap();
    let new_start =
        pl_debug_start_core(&fixture.state, &owner, fixture.start_request("after-runtime-mutation")).unwrap();
    fixture.receipt(&owner, &fixture.reference(&new_start), "after-runtime-mutation").await;
    fixture.close(&owner, &fixture.reference(&new_start)).await;
    assert_eq!(fixture.count("business_dispatch"), 2);
}

#[tokio::test]
async fn mutation_retry_after_runtime_operation_failure_rejoins_its_original_drain_not_another_owners_history() {
    let fixture = Fixture::new("normal").await;
    let history_owner = PlDebugAccess::web("history".into()).unwrap();
    let history =
        pl_debug_start_core(&fixture.state, &history_owner, fixture.start_request("history-before-failure")).unwrap();
    let history_ref = fixture.reference(&history);
    fixture.receipt(&history_owner, &history_ref, "history-before-failure").await;
    fixture.close(&history_owner, &history_ref).await;
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started =
        pl_debug_start_core(&fixture.state, &owner, fixture.start_request("before-mutation-failure")).unwrap();
    fixture.receipt(&owner, &fixture.reference(&started), "before-mutation-failure").await;
    {
        let permit =
            pl_debug_claim_mutation_core(&fixture.state, Some(&owner), PlDebugMutationScope::Driver("oracle".into()))
                .unwrap();
        let result: Result<(), String> = permit.after_debug_cleanup(async { Err("replacement failed".into()) }).await;
        assert_eq!(result.unwrap_err(), "replacement failed");
    }
    let original = fixture.state.pl_debug.lock().connection_drains.get("conn").unwrap().intent.clone();
    let other_owner_denied = pl_debug_claim_mutation_core(
        &fixture.state,
        Some(&history_owner),
        PlDebugMutationScope::Driver("oracle".into()),
    )
    .is_err();
    let permit =
        pl_debug_claim_mutation_core(&fixture.state, Some(&owner), PlDebugMutationScope::Driver("oracle".into()))
            .unwrap();
    permit
        .after_debug_cleanup(async {
            fixture.state.agent_manager.stop_daemon_by_key("oracle").await;
            Ok(())
        })
        .await
        .unwrap();
    drop(permit);
    let new_start = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("after-mutation-failure"))
        .unwrap_or_else(|error| panic!("explicit runtime retry did not finish its original drain: {error}"));
    assert!(other_owner_denied, "another owner claimed the retained original cleanup");
    assert_eq!(original.entries.len(), 1, "completed other-owner history was captured as active cleanup");
    assert!(fixture.state.pl_debug.lock().connection_drains.is_empty());
    fixture.receipt(&owner, &fixture.reference(&new_start), "after-mutation-failure").await;
    fixture.close(&owner, &fixture.reference(&new_start)).await;
    assert_eq!(fixture.count("business_dispatch"), 3);
    assert_eq!(fixture.count("pl_debug_close"), 3);
}

#[tokio::test]
async fn mutation_retry_after_cancelled_runtime_operation_keeps_the_original_scope_and_deadline() {
    let fixture = Fixture::new("normal").await;
    let owner = PlDebugAccess::web("first".into()).unwrap();
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("before-mutation-cancel")).unwrap();
    fixture.receipt(&owner, &fixture.reference(&started), "before-mutation-cancel").await;
    let app = fixture.state.clone();
    let task_owner = owner.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let operation = tokio::spawn(async move {
        let permit = pl_debug_claim_mutation_core(&app, Some(&task_owner), PlDebugMutationScope::AllRuntimes).unwrap();
        permit
            .after_debug_cleanup(async {
                entered_tx.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), entered_rx).await.unwrap().unwrap();
    let original = fixture.state.pl_debug.lock().connection_drains.get("conn").unwrap().intent.clone();
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    let retained = fixture.state.pl_debug.lock().connection_drains.get("conn").unwrap().intent.clone();
    assert!(Arc::ptr_eq(&original, &retained));
    assert_eq!(original.deadline, retained.deadline);
    let permit = pl_debug_claim_mutation_core(&fixture.state, Some(&owner), PlDebugMutationScope::AllRuntimes).unwrap();
    permit
        .after_debug_cleanup(async {
            fixture.state.agent_manager.stop_daemons().await;
            Ok(())
        })
        .await
        .unwrap();
    drop(permit);
    let new_start = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("after-mutation-cancel"))
        .unwrap_or_else(|error| {
            panic!("explicit cancelled-operation retry did not finish its original drain: {error}")
        });
    fixture.receipt(&owner, &fixture.reference(&new_start), "after-mutation-cancel").await;
    fixture.close(&owner, &fixture.reference(&new_start)).await;
    assert_eq!(fixture.count("business_dispatch"), 2);
    assert_eq!(fixture.count("pl_debug_close"), 2);
}

struct Fixture {
    state: Arc<AppState>,
    _directory: tempfile::TempDir,
    listener: tokio::task::JoinHandle<()>,
    driver_type: &'static str,
}

impl Fixture {
    async fn new(mode: &str) -> Self {
        Self::new_for_driver(mode, DatabaseType::Oracle, "oracle").await
    }

    async fn new_for_driver(mode: &str, db_type: DatabaseType, driver_type: &'static str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "test",
        ));
        let driver = state.agent_manager.driver_dir(driver_type);
        std::fs::create_dir_all(&driver).unwrap();
        std::fs::write(driver.join("mode"), mode).unwrap();
        std::fs::write(driver.join("agent.py"), r#"import json, os, pathlib, sys, threading, time
root=pathlib.Path(__file__).parent
mode=(root/'mode').read_text(); output_lock=threading.Lock(); stopped=threading.Event()
snapshot={'state':'paused','stopRevision':1,'executionStopped':False,'executionOutcome':'pending','releaseState':'open','transactionOutcome':'pending','targetDispatched':True}
assignment_records={}
compile_records={}
if mode=='missing_stop': del snapshot['stopRevision']
def event(method, **values):
    with open(root/'events','a',encoding='utf-8') as f: f.write(json.dumps({'method':method,**values})+'\n')
if mode=='capture_env': event('launch_env',tns_admin=os.environ.get('TNS_ADMIN'),nls_lang=os.environ.get('NLS_LANG'))
def reply(req,result):
    with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result},ensure_ascii=True),flush=True)
def gate(name):
    while not (root/name).exists(): time.sleep(0.01)
def handle(req):
    method=req['method']; params=req.get('params',{}); event(method)
    if method=='handshake':
        if mode=='registered_inspect_handshake_hold': event('handshake_wait'); gate('handshake-gate')
        result={'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session','structured_error_v1']}
        if mode!='legacy': result['plDebug']={'contractVersion':1,'helperObjects':mode=='helper'}
        if mode.startswith('assignment_') and mode!='assignment_legacy': result['plDebug']['setValueOperationStatus']=True
        if mode.startswith('execute_') and 'legacy' not in mode: result['plDebug']['executeOperationStatus']=True
        if mode.startswith('breakpoint_') and mode!='breakpoint_legacy': result['plDebug']['breakpointOperationStatus']=True
        if mode.startswith('results_'): result['capabilities'].append('pl_debug_retained_results_v1')
    elif method=='open_session':
        event('credential_check',matched=params.get('password')=='fixture-secret',role=params.get('sessionRole'))
        if mode=='registered_inspect_open_hold': event('open_wait'); gate('open-gate')
        result={'ok':True}
    elif method=='close_session':
        if mode.startswith('registered_inspect'):
            event('session_close_entered',agentSessionId=params.get('agentSessionId'))
            if mode=='registered_inspect_hold': gate('inspect-gate')
            if mode=='registered_inspect_open_hold': gate('open-gate')
            if mode=='registered_inspect_close_hold': gate('session-close-gate')
            if mode=='registered_inspect_close_fail':
                with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'physical close not confirmed'}}),flush=True)
                return
        result={'ok':True}
    elif method=='pl_debug_start':
        event('business_dispatch',operationId=params.get('operationId'),scope=os.environ.get('DBX_PL_DEBUG_RUNTIME_SCOPE'))
        if mode=='start_hold': gate('start-gate')
        snapshot['debugId']=params['operationId']; snapshot['startOperationId']=params['operationId']; result=dict(snapshot)
    elif method=='pl_debug_compile':
        result={'operationId':params['operationId'],'dispatched':True,'ddlState':'unknown' if mode=='compile_unknown' else 'executed','finished':True,'readback':{'status':'INVALID','diagnosticsComplete':True,'diagnostics':[{'text':'fixture compile error'}]}}
        compile_records[params['operationId']]=result
        event('compile_dispatch')
        if mode=='compile_hold': gate('compile-gate')
        if mode=='compile_lost_reply':
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'lost original compilation response'}}),flush=True)
            return
    elif method=='pl_debug_compile_status': result=compile_records[params['operationId']]
    elif method=='pl_debug_inspect':
        event('inspect_entered',target=params.get('target'))
        if mode=='inspect_recoverable_error':
            error={'contractVersion':1,'category':'connection','retryable':True,'sessionDisposition':'quarantine','stage':'execute','operationOutcome':'unknown','agentSessionId':params.get('agentSessionId')}
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'connection reset by peer','data':error}}),flush=True)
            return
        if mode in ('inspect_hold','registered_inspect_hold','registered_inspect_compile_hold'): gate('inspect-gate')
        result={'capabilities':{'canAttemptStart':True,'startVerified':False},'connectionRevision':'untrusted-agent-revision'}
        if params.get('target') is not None: result['targetPreview']={'schema':params['target']['schema'],'state':'available','candidates':[]}
    elif method=='pl_debug_resume':
        snapshot['state']='running'; event('resume_entered'); stopped.wait()
        if mode=='late_resume': gate('resume-gate')
        result={'state':'paused','stopRevision':1,'executionStopped':False,'executionOutcome':'pending','releaseState':'open'}
    elif method=='pl_debug_abort':
        snapshot.update(state='ended',executionStopped=True,executionOutcome='cancelled'); stopped.set(); result=dict(snapshot)
    elif method=='pl_debug_close':
        event('close_entered'); stopped.set()
        if mode=='close_delay': gate('close-gate')
        snapshot.update(state='ended',executionStopped=True,executionOutcome='cancelled',releaseState='released',transactionOutcome='rolled_back')
        result=True
    elif method in ('pl_debug_get_variables','pl_debug_get_value','pl_debug_get_stack'):
        event('read_binding',stopRevision=params.get('stopRevision'),debugId=params.get('debugId'),frame=params.get('frame',0))
        result={**snapshot,'variables':[{'name':'N','state':'value','value':'41'}],'frame':params.get('frame',0)}
        if mode=='read_delay': event('read_entered'); gate('read-gate')
    elif method=='pl_debug_step_over':
        snapshot['stopRevision']+=1; result=dict(snapshot)
        if mode=='assignment_rejected': result.update(ok=False,result=77)
    elif method=='pl_debug_set_value':
        event('assignment_binding',operationId=params.get('operationId'),debugId=params.get('debugId'),stopRevision=params.get('stopRevision'))
        code=77 if mode=='assignment_rejected' else 0
        result={'ok':code==0,'result':code,'message':'native assignment result','operationId':params['operationId'],'stopRevision':snapshot['stopRevision'],'snapshot':dict(snapshot)}
        if mode=='assignment_invalid': result['ok']=False
        assignment_records[params['operationId']]={'operationId':params['operationId'],'action':'set_value','state':'succeeded' if code==0 else 'failed','stopRevision':snapshot['stopRevision'],'result':result}
        if mode in ('assignment_lost','assignment_legacy','assignment_late'):
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'original response lost'}}),flush=True)
            return
    elif method in ('pl_debug_set_breakpoints','pl_debug_delete_breakpoints','pl_debug_set_breakpoint_enabled'):
        event('breakpoint_binding',operationId=params.get('operationId'),debugId=params.get('debugId'),stopRevision=params.get('stopRevision'))
        code=77 if mode=='breakpoint_rejected' else 0
        result={'ok':code==0,'result':code,'operationId':params['operationId'],'stopRevision':snapshot['stopRevision'],'snapshot':dict(snapshot)}
        if mode=='breakpoint_invalid': result['ok']=False
        if mode=='breakpoint_wrong_id': result['operationId']='different'
        assignment_records[params['operationId']]={'operationId':params['operationId'],'action':method.removeprefix('pl_debug_'),'state':'succeeded' if code==0 else 'failed','stopRevision':snapshot['stopRevision'],'result':result}
        if mode.startswith('breakpoint_predispatch'):
            snapshot['state']='unknown'; snapshot['breakpointInventoryState']='unknown'
            result={'ok':False,'operationId':params['operationId'],'stopRevision':snapshot['stopRevision'],'items':[{'index':0,'state':'failed'}],'breakpoints':[]}
            error={'contractVersion':1,'category':'protocol','retryable':False,'sessionDisposition':'keep','stage':'request','operationOutcome':'not_started','message':'Inventory read failed before SET'}
            record={'operationId':params['operationId'],'action':method.removeprefix('pl_debug_'),'state':'failed','stopRevision':snapshot['stopRevision'],'result':result,'error':error}
            if mode.endswith('_partial'): result['items'].insert(0,{'index':0,'state':'succeeded'})
            if mode.endswith('_wrong_stop'): record['stopRevision']=99
            if mode.endswith('_wrong_action'): record['action']='set_value'
            assignment_records[params['operationId']]=record
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'original rejection response lost'}}),flush=True)
            return
        if mode in ('breakpoint_lost','breakpoint_late'):
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'original breakpoint response lost'}}),flush=True)
            return
    elif method=='pl_debug_execute':
        event('execute_binding',operationId=params.get('operationId'),debugId=params.get('debugId'),stopRevision=params.get('stopRevision'),sql=params.get('sql'))
        result={'ok':mode not in ('execute_rejected','execute_failed_partial'),'rows':[None,''],'count':2}
        if not result['ok']: result['error']='ORA-20001: original SQL failure'
        if 'legacy' not in mode:
            result.update(operationId=params['operationId'],action='execute',stopRevision=snapshot['stopRevision'],complete=True,truncated=False,snapshot=dict(snapshot))
        if mode in ('execute_partial','execute_failed_partial'): result.update(complete=False,resultError='Original result capture incomplete')
        if mode=='execute_invalid': result['operationId']='spoofed'
        assignment_records[params['operationId']]={'operationId':params['operationId'],'action':'execute','state':'succeeded' if result['ok'] else 'failed','stopRevision':snapshot['stopRevision'],'result':result}
        if mode.startswith('execute_prepare_'):
            error={'contractVersion':1,'category':'sql','retryable':False,'sessionDisposition':'keep','stage':'prepare','operationOutcome':'not_started','message':'Original prepare failed'}
            record={'operationId':params['operationId'],'action':'execute','state':'failed','stopRevision':snapshot['stopRevision'],'result':None,'error':error}
            if mode=='execute_prepare_wrong_stop_lost': record['stopRevision']=99
            if mode=='execute_prepare_unknown_lost': error['operationOutcome']='unknown'
            assignment_records[params['operationId']]=record
        if mode.endswith('_lost'):
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'original SQL response lost'}}),flush=True)
            return
    elif method=='pl_debug_operation_status':
        event('assignment_recovery_entered')
        if mode in ('assignment_lost','assignment_late','breakpoint_lost','breakpoint_late'): gate('assignment-recovery-gate')
        result=assignment_records[params['operationId']]
    elif method=='pl_debug_get_log':
        result={**snapshot,'output':'one\n\n中😀*|\\\n','outputComplete':True,'outputTruncated':False,'outputError':None}
    elif method in ('pl_debug_get_results','pl_debug_get_result_page'):
        if mode=='results_early_exit': event('process_exit'); os._exit(0)
        if mode=='results_manifest_fail' or mode=='results_page_fail' and method=='pl_debug_get_result_page' and params['offset']>0:
            error={'contractVersion':1,'category':'protocol','retryable':False,'sessionDisposition':'keep','stage':'execute','operationOutcome':'unknown','agentSessionId':params.get('agentSessionId')}
            with output_lock: print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'injected retained read failure','data':error}}),flush=True)
            return
        scope=os.environ.get('DBX_PL_DEBUG_RUNTIME_SCOPE','')
        text=scope+':'+'a'*(65534-len(scope))+'😀tail'; encoded=text.encode('utf-16-le'); length=len(encoded)//2
        manifest={'generation':'fixture-generation','resultId':'fixture-result','encoding':'utf16','lengthUnit':'utf16','length':length,'complete':True,'truncated':False,'state':'available'}
        if method=='pl_debug_get_results': result={'collectionState':'available','results':[manifest]}
        else:
            offset=params['offset']; end=min(length,offset+params['limit'])
            if end<length and 0xD800<=int.from_bytes(encoded[2*(end-1):2*end],'little')<=0xDBFF: end-=1
            if mode=='results_page_hold' and offset>0 or mode=='results_read_hold' and offset==0:
                event('result_page_wait'); gate('result-page-gate')
            result={**manifest,'offset':offset,'nextOffset':end,'eof':end==length,'data':encoded[2*offset:2*end].decode('utf-16-le')}
    elif method=='pl_debug_list_breakpoints': result=[]
    elif method=='shutdown':
        reply(req,{'ok':True})
        if mode=='registered_inspect_shutdown_alive': event('shutdown_ack'); gate('exit-gate')
        event('process_exit'); os._exit(0)
    else: result=dict(snapshot)
    reply(req,result)
if mode.startswith('registered_inspect'): event('runtime_binding',scope=os.environ.get('DBX_PL_DEBUG_RUNTIME_SCOPE'))
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    threading.Thread(target=handle,args=(json.loads(line),),daemon=True).start()
"#).unwrap();
        std::fs::write(
            state.agent_manager.driver_launch_config_path(driver_type),
            json!({
                "command":if cfg!(windows) {"python"} else {"python3"},
                "args":["{driver_dir}/agent.py"],"working_dir":"{driver_dir}"
            })
            .to_string(),
        )
        .unwrap();
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let listener = tokio::spawn(async move {
            while let Ok((socket, _)) = socket.accept().await {
                drop(socket);
            }
        });
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id":"conn","name":"Debug fixture","db_type":db_type,"host":"127.0.0.1","port":port,
            "username":"fixture","password":"","database":"xe","save_password":false
        }))
        .unwrap();
        state.configs.write().await.insert("conn".into(), config);
        state.session_credentials.set("", "conn", "fixture-secret");
        Self { state, _directory: directory, listener, driver_type }
    }

    fn start_request(&self, id: &str) -> PlDebugStart {
        PlDebugStart {
            server_epoch: self.state.pl_debug.epoch,
            operation_id: id.into(),
            connection_id: "conn".into(),
            database: "APP".into(),
            client_session_id: "editor-one".into(),
            target: json!({"source":"BEGIN NULL; END;","schema":"APP"}),
            risk_accepted: true,
            production_confirmed: false,
            expected_connection_revision: None,
        }
    }
    fn reference(&self, receipt: &PlDebugReceipt) -> PlDebugSessionRef {
        PlDebugSessionRef {
            server_epoch: receipt.server_epoch,
            session_id: receipt.session_id.clone(),
            connection_id: "conn".into(),
            client_session_id: "editor-one".into(),
        }
    }
    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(self.state.agent_manager.driver_dir(self.driver_type).join("events"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn count(&self, method: &str) -> usize {
        self.events().iter().filter(|event| event["method"] == method).count()
    }
    async fn wait_event(&self, method: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.count(method) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    fn release(&self, name: &str) {
        std::fs::write(self.state.agent_manager.driver_dir(self.driver_type).join(name), "ready").unwrap();
    }
    async fn receipt(&self, access: &PlDebugAccess, reference: &PlDebugSessionRef, id: &str) -> PlDebugReceipt {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let receipt = pl_debug_operation_core(&self.state, access, reference, id).unwrap();
                if !matches!(receipt.state, OperationState::Accepted | OperationState::Running) {
                    return receipt;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn operation(
        &self,
        access: &PlDebugAccess,
        reference: &PlDebugSessionRef,
        id: &str,
        action: PlDebugAction,
    ) -> PlDebugOperation {
        let view = pl_debug_status_core(&self.state, access, reference, false).await.unwrap();
        PlDebugOperation {
            session: reference.clone(),
            operation_id: id.into(),
            expected_revision: view["revision"].as_u64().unwrap(),
            generation: view["generation"].as_u64().unwrap(),
            action,
            params: json!({}),
            production_confirmed: false,
        }
    }
    async fn close(&self, access: &PlDebugAccess, reference: &PlDebugSessionRef) {
        let operation = self.operation(access, reference, "close-fixture", PlDebugAction::Close).await;
        pl_debug_operate_core(&self.state, access, operation).await.unwrap();
        let receipt = self.receipt(access, reference, "close-fixture").await;
        assert!(matches!(receipt.state, OperationState::Succeeded), "{}", serde_json::to_string(&receipt).unwrap());
    }

    async fn idle_query_pool(&self) {
        self.state.configs.write().await.get_mut("conn").unwrap().idle_disconnect_secs = 1;
        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();
        self.state
            .update_connection_pools(|pools| pools.insert("conn".into(), crate::connection::PoolKind::Sqlite(pool)))
            .await;
        self.state.touch_pool_activity("conn").await;
        tokio::time::sleep(Duration::from_millis(1100)).await;
    }

    async fn runtime_transport(&self) -> u16 {
        let port = self.state.configs.read().await.get("conn").unwrap().port;
        self.state
            .proxy_tunnels
            .start_tunnel(
                "conn",
                crate::models::connection::ProxyType::Socks5,
                "127.0.0.1",
                port,
                "",
                "",
                "127.0.0.1",
                port,
            )
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for entry in self.state.pl_debug.lock().sessions.values() {
            if let Some(channel) = &entry.lock().channel {
                channel.fail_stop();
            }
        }
        for inspection in self.state.pl_debug.lock().inspections.values() {
            inspection.isolate();
        }
        self.listener.abort();
    }
}

fn registered_inspection_request() -> PlDebugInspect {
    PlDebugInspect {
        connection_id: "conn".into(),
        database: "APP".into(),
        client_session_id: "typed-preview".into(),
        target: Some(PlDebugInspectTarget {
            schema: "APP".into(),
            object_type: "PROCEDURE".into(),
            object_name: "P".into(),
            package_name: String::new(),
            metadata_preparation: Some("type_only".into()),
        }),
    }
}

fn compilation_request(fixture: &Fixture, id: &str) -> PlDebugCompile {
    PlDebugCompile {
        server_epoch: fixture.state.pl_debug.epoch,
        operation_id: id.into(),
        connection_id: "conn".into(),
        database: "APP".into(),
        client_session_id: "compile-client".into(),
        target: registered_inspection_request().target,
        preview: json!({"canCompile":true,"schema":"APP","objectName":"P","objectType":"PROCEDURE","sql":"server-generated compile SQL"}),
        expected_connection_revision: connection_revision(
            fixture.state.pl_debug.epoch,
            &fixture.state.connection_lifecycle_snapshot("conn"),
        ),
        confirmed: true,
        production_confirmed: false,
    }
}

fn compilation_reference(request: &PlDebugCompile) -> PlDebugCompileRef {
    PlDebugCompileRef {
        server_epoch: request.server_epoch,
        operation_id: request.operation_id.clone(),
        connection_id: request.connection_id.clone(),
        client_session_id: request.client_session_id.clone(),
    }
}

async fn finished_compilation(fixture: &Fixture, access: &PlDebugAccess, request: &PlDebugCompile) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = pl_debug_compile_status_core(&fixture.state, access, compilation_reference(request)).unwrap();
        if result["finished"] == true {
            return result;
        }
        assert!(Instant::now() < deadline, "compilation did not finish: {result}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn compilation_core_retains_original_ddl_facts_and_blocks_unresolved_replays() {
    for mode in ["compile_hold", "compile_lost_reply", "compile_unknown", "registered_inspect_close_fail"] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let request = compilation_request(&fixture, "original-compilation");
        let accepted = pl_debug_compile_core(&fixture.state, &access, request.clone()).await.unwrap();
        assert_eq!(accepted["operationId"], "original-compilation");
        assert_eq!(accepted["target"], json!({"schema":"APP","objectName":"P","objectType":"PROCEDURE"}));
        fixture.wait_event("compile_dispatch").await;
        if mode == "compile_hold" {
            let pending =
                pl_debug_compile_status_core(&fixture.state, &access, compilation_reference(&request)).unwrap();
            assert_eq!(pending["finished"], false);
            assert_eq!(pending["ddlState"], "unknown");
            assert!(pl_debug_start_core(
                &fixture.state,
                &PlDebugAccess::web("other-owner".into()).unwrap(),
                fixture.start_request("during-compile")
            )
            .is_err());
            assert!(pl_debug_claim_mutation_core(
                &fixture.state,
                Some(&access),
                PlDebugMutationScope::Connections(vec!["conn".into()])
            )
            .is_err());
            assert!(pl_debug_claim_mutation_core(
                &fixture.state,
                Some(&access),
                PlDebugMutationScope::Driver("oracle".into())
            )
            .is_err());
            fixture.release("compile-gate");
        }
        let result = finished_compilation(&fixture, &access, &request).await;
        assert_eq!(result["target"], accepted["target"]);
        assert_eq!(result["ddlState"], if mode == "compile_unknown" { "unknown" } else { "executed" });
        assert_eq!(
            result["releaseState"],
            if mode == "registered_inspect_close_fail" { "unconfirmed" } else { "released" }
        );
        if mode == "registered_inspect_close_fail" {
            assert!(result["cleanupError"].is_string());
        }
        if mode != "compile_unknown" {
            assert_eq!(result["result"]["readback"]["status"], "INVALID");
        }
        assert_eq!(fixture.count("compile_dispatch"), 1);
        if mode == "compile_lost_reply" {
            assert_eq!(fixture.count("pl_debug_compile_status"), 1);
        }
        fixture.state.configs.write().await.get_mut("conn").unwrap().read_only = true;
        assert_eq!(
            pl_debug_compile_core(&fixture.state, &access, request.clone()).await.unwrap()["ddlState"],
            result["ddlState"]
        );
        fixture.state.configs.write().await.get_mut("conn").unwrap().read_only = false;
        let mut changed = request.clone();
        changed.preview["sql"] = json!("different content");
        assert!(pl_debug_compile_core(&fixture.state, &access, changed).await.is_err());
        let foreign = PlDebugAccess::web("foreign-owner".into()).unwrap();
        assert!(pl_debug_compile_status_core(&fixture.state, &foreign, compilation_reference(&request)).is_err());
        let mut wrong_client = compilation_reference(&request);
        wrong_client.client_session_id = "foreign-client".into();
        assert!(pl_debug_compile_status_core(&fixture.state, &access, wrong_client).is_err());
        if mode == "compile_unknown" || mode == "registered_inspect_close_fail" {
            assert!(pl_debug_compile_core(&fixture.state, &access, compilation_request(&fixture, "new-id"))
                .await
                .is_err());
            assert!(fixture.state.pl_debug.try_idle_fence("conn").is_none());
        }
        assert_eq!(fixture.count("compile_dispatch"), 1);
    }
}

#[tokio::test]
async fn compilation_core_rechecks_write_protection_after_original_session_open() {
    let fixture = Fixture::new("registered_inspect_open_hold").await;
    let access = PlDebugAccess::desktop();
    let request = compilation_request(&fixture, "write-guard-recheck");
    pl_debug_compile_core(&fixture.state, &access, request.clone()).await.unwrap();
    fixture.wait_event("open_wait").await;
    fixture.state.configs.write().await.get_mut("conn").unwrap().read_only = true;
    fixture.release("open-gate");
    let result = finished_compilation(&fixture, &access, &request).await;
    assert_eq!(result["ddlState"], "not_started");
    assert_eq!(result["dispatched"], false);
    assert_eq!(result["releaseState"], "released");
    assert_eq!(fixture.count("compile_dispatch"), 0);
}

#[tokio::test]
async fn compilation_core_rejects_missing_confirmation_readonly_production_and_stale_revision_before_registration() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let original = compilation_request(&fixture, "not-admitted");
    let mut request = original.clone();
    request.confirmed = false;
    assert!(pl_debug_compile_core(&fixture.state, &access, request).await.is_err());
    let mut request = original.clone();
    request.expected_connection_revision = "stale".into();
    assert!(pl_debug_compile_core(&fixture.state, &access, request).await.is_err());
    fixture.state.configs.write().await.get_mut("conn").unwrap().read_only = true;
    assert!(pl_debug_compile_core(&fixture.state, &access, original.clone()).await.is_err());
    let mut configs = fixture.state.configs.write().await;
    let config = configs.get_mut("conn").unwrap();
    config.read_only = false;
    config.is_production = true;
    drop(configs);
    assert!(pl_debug_compile_core(&fixture.state, &access, original).await.is_err());
    assert!(fixture.state.pl_debug.lock().compilations.is_empty());
    assert_eq!(fixture.count("open_session"), 0);
    assert_eq!(fixture.count("compile_dispatch"), 0);
}

#[tokio::test]
async fn compilation_preview_uses_registered_inspection_for_both_engines() {
    let fixture = Fixture::new("registered_inspect").await;
    let access = PlDebugAccess::desktop();
    let mut request = registered_inspection_request();
    request.target.as_mut().unwrap().metadata_preparation = Some("debug_compile".into());
    for db_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
        fixture.state.configs.write().await.get_mut("conn").unwrap().db_type = db_type;
        assert!(pl_debug_prepare_inspection_core(&fixture.state, &request).await.unwrap().is_some());
        let error = pl_debug_inspect_core(&fixture.state, &access, request.clone()).await.unwrap_err();
        assert!(error.contains("registered dedicated channel"));
    }
    request.target.as_mut().unwrap().metadata_preparation = Some("type_only".into());
    assert!(pl_debug_prepare_inspection_core(&fixture.state, &request).await.unwrap().is_none());
    assert_eq!(fixture.count("open_session"), 0);
    assert_eq!(fixture.count("business_dispatch"), 0);
}

#[tokio::test]
async fn compilation_preview_blocks_new_start_and_restart_across_clients_until_physical_release() {
    let fixture = Fixture::new("registered_inspect_compile_hold").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("original")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "original").await;
    fixture.close(&access, &reference).await;
    let restart = fixture.operation(&access, &reference, "restart-after-preview", PlDebugAction::Restart).await;
    let mut request = registered_inspection_request();
    request.target.as_mut().unwrap().metadata_preparation = Some("debug_compile".into());
    let admission = pl_debug_prepare_inspection_core(&fixture.state, &request).await.unwrap().unwrap();
    let submission = pl_debug_submit_inspection_core(&fixture.state, &access, admission).unwrap();
    let pending = tokio::spawn(submission.wait());
    fixture.wait_event("pl_debug_inspect").await;
    let foreign_access = PlDebugAccess::web("another-owner".into()).unwrap();
    let mut other_start = fixture.start_request("start-after-preview");
    other_start.client_session_id = "another-client".into();
    assert!(pl_debug_start_core(&fixture.state, &foreign_access, other_start.clone()).is_err());
    assert!(pl_debug_operate_core(&fixture.state, &access, restart.clone()).await.is_err());
    assert_eq!(fixture.count("business_dispatch"), 1);
    assert!(!fixture
        .state
        .pl_debug
        .lock()
        .starts
        .contains_key(&(foreign_access.owner.clone(), other_start.operation_id.clone())));
    fixture.release("inspect-gate");
    pending.await.unwrap().unwrap();
    assert!(fixture.state.pl_debug.lock().inspections.is_empty());
    let accepted = pl_debug_operate_core(&fixture.state, &access, restart).await.unwrap();
    assert_eq!(accepted.generation, 2);
    fixture.receipt(&access, &reference, "restart-after-preview").await;
    let close = fixture.operation(&access, &reference, "close-after-preview", PlDebugAction::Close).await;
    pl_debug_operate_core(&fixture.state, &access, close).await.unwrap();
    fixture.receipt(&access, &reference, "close-after-preview").await;
}

#[tokio::test]
async fn pending_debug_start_blocks_compilation_preview_before_any_metadata_runtime() {
    let fixture = Fixture::new("registered_inspect").await;
    let access = PlDebugAccess::desktop();
    fixture.state.pl_debug.register(&fixture.state, &access, fixture.start_request("reserved-start")).unwrap();
    let mut request = registered_inspection_request();
    request.target.as_mut().unwrap().metadata_preparation = Some("debug_compile".into());
    let foreign_access = PlDebugAccess::web("another-owner".into()).unwrap();
    let admission = pl_debug_prepare_inspection_core(&fixture.state, &request).await.unwrap().unwrap();
    assert!(pl_debug_submit_inspection_core(&fixture.state, &foreign_access, admission).is_err());
    assert!(fixture.state.pl_debug.lock().inspections.is_empty());
    assert!(fixture.state.agent_manager.connection_runtimes.lock().await.is_empty());
    assert_eq!(fixture.count("open_session"), 0);
}

async fn submit_registered_inspection(fixture: &Fixture, access: &PlDebugAccess) -> PlDebugInspectionSubmission {
    let admission = pl_debug_prepare_inspection_core(&fixture.state, &registered_inspection_request())
        .await
        .unwrap()
        .expect("Oracle type_only must use a registered inspection");
    pl_debug_submit_inspection_core(&fixture.state, access, admission).unwrap()
}

#[tokio::test]
async fn registered_inspection_publishes_only_after_close_exit_and_retirement() {
    for credential_owner in [None, Some("inspection-credential-owner")] {
        let fixture = Fixture::new("registered_inspect_close_hold").await;
        let access = with_credential_owner(credential_owner.map(str::to_owned), async {
            PlDebugAccess::web("inspection-browser".into()).unwrap()
        })
        .await;
        if let Some(owner) = credential_owner {
            fixture.state.session_credentials.set(owner, "conn", "fixture-secret");
            fixture.state.session_credentials.set("", "conn", "wrong-default");
        } else {
            fixture.state.session_credentials.set("inspection-browser", "conn", "wrong-browser-credential");
        }
        let lifecycle = fixture.state.connection_lifecycle_snapshot("conn");
        let submission = submit_registered_inspection(&fixture, &access).await;
        let pending = tokio::spawn(submission.wait());
        fixture.wait_event("session_close_entered").await;
        assert!(!pending.is_finished());
        assert!(fixture.state.pl_debug.lock().sessions.is_empty());
        assert_eq!(fixture.state.pl_debug.lock().inspections.len(), 1);
        assert_eq!(fixture.state.agent_manager.connection_runtimes.lock().await.len(), 1);
        assert_eq!(fixture.count("business_dispatch"), 0);
        let credentials = fixture.events().into_iter().find(|event| event["method"] == "credential_check").unwrap();
        assert_eq!(credentials["matched"], true);
        assert_eq!(credentials["role"], "metadata");
        fixture.release("session-close-gate");
        let result = pending.await.unwrap().unwrap();
        assert_eq!(result["connectionRevision"], connection_revision(fixture.state.pl_debug.epoch, &lifecycle));
        assert!(fixture.state.pl_debug.lock().inspections.is_empty());
        assert!(fixture.state.agent_manager.connection_runtimes.lock().await.is_empty());
        let events = fixture.events();
        let methods = events
            .iter()
            .filter_map(|event| event["method"].as_str())
            .filter(|method| matches!(*method, "open_session" | "pl_debug_inspect" | "close_session" | "shutdown"))
            .collect::<Vec<_>>();
        assert_eq!(methods, ["open_session", "pl_debug_inspect", "close_session", "shutdown"]);
        assert_eq!(fixture.count("process_exit"), 1);
        let binding = events.iter().find(|event| event["method"] == "runtime_binding").unwrap();
        assert!(Uuid::parse_str(binding["scope"].as_str().unwrap()).is_ok());
    }
}

#[tokio::test]
async fn registered_inspection_revocation_during_launch_or_open_prevents_metadata_dispatch() {
    for (mode, entered, gate, opens) in [
        ("registered_inspect_handshake_hold", "handshake_wait", "handshake-gate", 0),
        ("registered_inspect_open_hold", "open_wait", "open-gate", 1),
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::web("inspection-browser".into()).unwrap();
        let pending = tokio::spawn(submit_registered_inspection(&fixture, &access).await.wait());
        fixture.wait_event(entered).await;
        pl_debug_revoke_web_owner_core(&fixture.state, "inspection-browser");
        fixture.release(gate);
        assert!(pending.await.unwrap().is_err());
        assert_eq!(fixture.count("open_session"), opens);
        assert_eq!(fixture.count("pl_debug_inspect"), 0);
        assert_eq!(fixture.count("close_session"), opens);
        assert_eq!(fixture.count("business_dispatch"), 0);
        assert!(fixture.state.pl_debug.lock().inspections.is_empty());
    }
}

#[tokio::test]
async fn registered_inspection_driver_mutation_waits_for_the_original_physical_close() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let fixture = Fixture::new("registered_inspect_hold").await;
    let access = PlDebugAccess::desktop();
    let pending = tokio::spawn(submit_registered_inspection(&fixture, &access).await.wait());
    fixture.wait_event("inspect_entered").await;
    let changed = AtomicBool::new(false);
    let permit =
        pl_debug_claim_mutation_core(&fixture.state, None, PlDebugMutationScope::Driver("oracle".into())).unwrap();
    let change = permit.after_debug_cleanup(async {
        changed.store(true, Ordering::Release);
        Ok(())
    });
    tokio::pin!(change);
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut change).await.is_err());
    assert!(!changed.load(Ordering::Acquire));
    assert_eq!(fixture.state.pl_debug.lock().inspections.len(), 1);
    fixture.release("inspect-gate");
    change.await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(changed.load(Ordering::Acquire));
    assert_eq!(fixture.count("pl_debug_inspect"), 1);
    assert_eq!(fixture.count("close_session"), 1);
    assert!(fixture.state.pl_debug.lock().sessions.is_empty());
    assert!(fixture.state.pl_debug.lock().inspections.is_empty());
}

#[tokio::test]
async fn registered_inspection_waiter_drop_keeps_the_server_cleanup_owner() {
    let fixture = Fixture::new("registered_inspect_hold").await;
    let pending = tokio::spawn(submit_registered_inspection(&fixture, &PlDebugAccess::desktop()).await.wait());
    fixture.wait_event("inspect_entered").await;
    let original = fixture.state.pl_debug.lock().inspections.values().next().unwrap().clone();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert!(!original.resources_quiescent());
    assert_eq!(fixture.state.pl_debug.lock().inspections.len(), 1);
    fixture.release("inspect-gate");
    inspection::wait_for_inspections(&[original], Instant::now() + Duration::from_secs(5)).await.unwrap();
    assert_eq!(fixture.count("pl_debug_inspect"), 1);
    assert_eq!(fixture.count("close_session"), 1);
    assert_eq!(fixture.count("business_dispatch"), 0);
    assert!(fixture.state.pl_debug.lock().inspections.is_empty());
}

#[tokio::test]
async fn registered_inspection_close_failure_and_shutdown_ack_cannot_publish_metadata() {
    let fixture = Fixture::new("registered_inspect_close_fail").await;
    let result = submit_registered_inspection(&fixture, &PlDebugAccess::desktop()).await.wait().await;
    assert!(matches!(result, Err(error) if error.contains("physical close not confirmed")));
    let original = fixture.state.pl_debug.lock().inspections.values().next().unwrap().clone();
    assert!(!original.resources_quiescent());
    assert!(inspection::wait_for_inspections(&[original], Instant::now() + Duration::from_millis(30)).await.is_err());
    assert_eq!(fixture.count("process_exit"), 1);
    assert_eq!(fixture.count("pl_debug_inspect"), 1);

    let fixture = Fixture::new("registered_inspect_shutdown_alive").await;
    let pending = tokio::spawn(submit_registered_inspection(&fixture, &PlDebugAccess::desktop()).await.wait());
    fixture.wait_event("shutdown_ack").await;
    assert!(!pending.is_finished());
    let original = fixture.state.pl_debug.lock().inspections.values().next().unwrap().clone();
    assert!(!original.resources_quiescent());
    original.isolate();
    assert!(pending.await.unwrap().is_err());
    inspection::wait_for_inspections(&[original], Instant::now() + Duration::from_secs(5)).await.unwrap();
}

#[tokio::test]
async fn registered_inspection_supervisor_abort_converges_original_cleanup() {
    for (mode, event, calls) in [
        ("registered_inspect_handshake_hold", "handshake_wait", 0),
        ("registered_inspect_shutdown_alive", "shutdown_ack", 1),
    ] {
        let fixture = Fixture::new(mode).await;
        let pending = tokio::spawn(submit_registered_inspection(&fixture, &PlDebugAccess::desktop()).await.wait());
        fixture.wait_event(event).await;
        let (scope, original) = fixture
            .state
            .pl_debug
            .lock()
            .inspections
            .iter()
            .next()
            .map(|(scope, owner)| (*scope, owner.clone()))
            .unwrap();
        fixture.state.pl_debug_supervisor().stop_and_wait(&format!("pl-debug-inspect:{scope}")).await;
        assert!(pending.await.unwrap().is_err());
        inspection::wait_for_inspections(&[original], Instant::now() + Duration::from_secs(5)).await.unwrap();
        assert_eq!(fixture.count("pl_debug_inspect"), calls);
        assert_eq!(fixture.count("close_session"), calls);
        assert!(fixture.state.pl_debug.lock().inspections.is_empty());
    }
}

#[tokio::test]
async fn registered_inspection_registration_rechecks_mutation_and_original_lifecycle() {
    let fixture = Fixture::new("registered_inspect_normal").await;
    let request = registered_inspection_request();
    let admission = pl_debug_prepare_inspection_core(&fixture.state, &request).await.unwrap().unwrap();
    let permit = pl_debug_claim_mutation_core(&fixture.state, None, PlDebugMutationScope::AllRuntimes).unwrap();
    assert!(pl_debug_submit_inspection_core(&fixture.state, &PlDebugAccess::desktop(), admission).is_err());
    drop(permit);
    let admission = pl_debug_prepare_inspection_core(&fixture.state, &request).await.unwrap().unwrap();
    fixture.state.invalidate_connection_lifecycle("conn");
    assert!(pl_debug_submit_inspection_core(&fixture.state, &PlDebugAccess::desktop(), admission).is_err());
    assert!(fixture.state.pl_debug.lock().inspections.is_empty());
    assert!(fixture.state.agent_manager.connection_runtimes.lock().await.is_empty());
}

#[tokio::test]
async fn registered_inspection_allows_same_runtime_tokens_but_blocks_unclaimed_replacement() {
    let fixture = Fixture::new("registered_inspect_hold").await;
    let pending = tokio::spawn(submit_registered_inspection(&fixture, &PlDebugAccess::desktop()).await.wait());
    fixture.wait_event("inspect_entered").await;
    let original = current_transport(&fixture.state, "conn").unwrap();
    let config = fixture.state.configs.read().await.get("conn").unwrap().clone();
    let refreshed = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    assert!(refreshed.endpoint.is_ok());
    assert!(original.same_runtime(&refreshed.stamp));
    assert!(!original.same_token(&refreshed.stamp));
    let mut changed = config;
    changed.port = if changed.port == u16::MAX { changed.port - 1 } else { changed.port + 1 };
    assert!(fixture.state.connection_endpoint_attempt("conn", &changed).await.is_err());
    assert!(current_transport(&fixture.state, "conn").unwrap().same_token(&refreshed.stamp));
    fixture.release("inspect-gate");
    assert!(pending.await.unwrap().is_ok());
    assert_eq!(fixture.count("pl_debug_inspect"), 1);
}

#[tokio::test]
async fn registered_inspection_does_not_grant_mutation_authority_over_another_business_owner() {
    let fixture = Fixture::new("registered_inspect_hold").await;
    let business_owner = PlDebugAccess::web("business-owner".into()).unwrap();
    let inspector = PlDebugAccess::web("inspection-owner".into()).unwrap();
    let start = pl_debug_start_core(&fixture.state, &business_owner, fixture.start_request("business-start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&business_owner, &reference, "business-start").await;
    let pending = tokio::spawn(submit_registered_inspection(&fixture, &inspector).await.wait());
    fixture.wait_event("inspect_entered").await;
    assert!(pl_debug_claim_mutation_core(
        &fixture.state,
        Some(&inspector),
        PlDebugMutationScope::Connections(vec!["conn".into()]),
    )
    .is_err());
    assert_eq!(fixture.count("pl_debug_close"), 0);
    fixture.release("inspect-gate");
    assert!(pending.await.unwrap().is_ok());
    fixture.close(&business_owner, &reference).await;
}

#[tokio::test]
async fn registered_inspection_preparation_failure_does_not_wait_for_its_own_task() {
    let fixture = Fixture::new("registered_inspect_normal").await;
    fixture.state.configs.write().await.get_mut("conn").unwrap().transport_layers = vec![serde_json::from_value(
        json!({"type":"ssh","id":"inspection-failed-hop","host":"","connect_timeout_secs":1}),
    )
    .unwrap()];
    let result = tokio::time::timeout(
        Duration::from_secs(8),
        pl_debug_inspect_dispatch_core(&fixture.state, &PlDebugAccess::desktop(), registered_inspection_request()),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(fixture.state.pl_debug.lock().inspections.is_empty());
    assert!(current_transport(&fixture.state, "conn").is_none());
    assert!(fixture.state.agent_manager.connection_runtimes.lock().await.is_empty());
    assert_eq!(fixture.count("open_session"), 0);
}

#[tokio::test]
async fn registered_inspection_deadline_does_not_start_cleanup_rpcs_or_late_launches() {
    let fixture = Fixture::new("registered_inspect_hold").await;
    let admission =
        pl_debug_prepare_inspection_core(&fixture.state, &registered_inspection_request()).await.unwrap().unwrap();
    let submission = inspection::submit_inspection_before(
        &fixture.state,
        &PlDebugAccess::desktop(),
        admission,
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    let pending = tokio::spawn(submission.wait());
    fixture.wait_event("inspect_entered").await;
    assert!(pending.await.unwrap().is_err());
    let original = fixture.state.pl_debug.lock().inspections.values().next().unwrap().clone();
    assert!(!original.resources_quiescent());
    assert_eq!(fixture.count("pl_debug_inspect"), 1);
    assert_eq!(fixture.count("close_session"), 0);
    assert_eq!(fixture.count("shutdown"), 0);
    original.isolate();

    let fixture = Fixture::new("registered_inspect_normal").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted, connected) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        accepted.send(()).unwrap();
        let _ = held.await;
        drop(socket);
    });
    fixture.state.configs.write().await.get_mut("conn").unwrap().transport_layers = vec![serde_json::from_value(
        json!({"type":"ssh","id":"inspection-late-hop","host":"127.0.0.1","port":port,"user":"fixture","connect_timeout_secs":10}),
    )
    .unwrap()];
    let admission =
        pl_debug_prepare_inspection_core(&fixture.state, &registered_inspection_request()).await.unwrap().unwrap();
    let submission = inspection::submit_inspection_before(
        &fixture.state,
        &PlDebugAccess::desktop(),
        admission,
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    let original = fixture.state.pl_debug.lock().inspections.values().next().unwrap().clone();
    tokio::time::timeout(Duration::from_secs(2), connected).await.unwrap().unwrap();
    assert!(submission.wait().await.is_err());
    assert!(!original.resources_quiescent());
    release.send(()).unwrap();
    peer.await.unwrap();
    inspection::wait_for_inspections(&[original], Instant::now() + Duration::from_secs(5)).await.unwrap();
    assert!(fixture.state.agent_manager.connection_runtimes.lock().await.is_empty());
    assert_eq!(fixture.count("open_session"), 0);
    assert_eq!(fixture.count("pl_debug_inspect"), 0);
}

#[tokio::test]
async fn start_intent_precedes_dispatch_and_retransmission_cannot_repeat_the_target() {
    let fixture = Fixture::new("start_hold").await;
    let access = PlDebugAccess::desktop();
    let request = fixture.start_request("start-once");
    let receipt = pl_debug_start_core(&fixture.state, &access, request.clone()).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.wait_event("business_dispatch").await;
    let retained = pl_debug_operation_core(&fixture.state, &access, &reference, "start-once").unwrap();
    assert!(retained.dispatched && matches!(retained.state, OperationState::Running));
    let listed = pl_debug_list_core(&fixture.state, &access, reference.server_epoch, "conn").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["startOperationId"], "start-once");
    let repeated = pl_debug_start_core(&fixture.state, &access, request.clone()).unwrap();
    assert_eq!(receipt.session_id, repeated.session_id);
    let mut duplicate = request.clone();
    duplicate.operation_id = "second-start".into();
    assert!(pl_debug_start_core(&fixture.state, &access, duplicate).is_err());
    let mut changed = request;
    changed.target["source"] = json!("BEGIN NULL; NULL; END;");
    assert!(pl_debug_start_core(&fixture.state, &access, changed).is_err());
    assert_eq!(fixture.count("business_dispatch"), 1);
    fixture.release("start-gate");
    assert!(matches!(fixture.receipt(&access, &reference, "start-once").await.state, OperationState::Succeeded));
    let status = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
    assert_eq!(status["startOperationId"], "start-once");
    let dispatch = fixture.events().into_iter().find(|event| event["method"] == "business_dispatch").unwrap();
    assert_ne!(dispatch["operationId"], status["startOperationId"]);
    let credentials = fixture.events().into_iter().find(|event| event["method"] == "credential_check").unwrap();
    assert_eq!(credentials["matched"], true);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn inspect_uses_metadata_owner_without_starting_a_debugger() {
    let fixture = Fixture::new("inspect").await;
    let access = PlDebugAccess::desktop();
    let lifecycle = fixture.state.connection_lifecycle_snapshot("conn");
    let result = pl_debug_inspect_core(
        &fixture.state,
        &access,
        PlDebugInspect {
            connection_id: "conn".into(),
            database: "APP".into(),
            client_session_id: "preview".into(),
            target: Some(PlDebugInspectTarget {
                schema: " Mixed Owner ".into(),
                object_type: "FUNCTION".into(),
                object_name: "f.x".into(),
                package_name: " Pkg. ".into(),
                metadata_preparation: None,
            }),
        },
    )
    .await
    .unwrap();
    assert_eq!(result["connectionRevision"], connection_revision(fixture.state.pl_debug.epoch, &lifecycle));
    assert_eq!(result["capabilities"]["startVerified"], false);
    assert_eq!(result["targetPreview"]["schema"], " Mixed Owner ");
    assert_eq!(fixture.count("pl_debug_inspect"), 1);
    assert_eq!(fixture.count("business_dispatch"), 0);
    assert!(fixture.state.pl_debug.lock().sessions.is_empty());
    let credentials = fixture.events().into_iter().find(|event| event["method"] == "credential_check").unwrap();
    assert_eq!(credentials["matched"], true);
    assert_eq!(credentials["role"], "metadata");
}

#[tokio::test]
async fn inspect_does_not_publish_old_metadata_with_a_new_connection_revision() {
    let fixture = Fixture::new("inspect_hold").await;
    let state = fixture.state.clone();
    let pending = tokio::spawn(async move {
        pl_debug_inspect_core(
            &state,
            &PlDebugAccess::desktop(),
            PlDebugInspect {
                connection_id: "conn".into(),
                database: "APP".into(),
                client_session_id: "preview".into(),
                target: None,
            },
        )
        .await
    });
    fixture.wait_event("inspect_entered").await;
    fixture.state.invalidate_connection_lifecycle("conn");
    fixture.release("inspect-gate");
    assert!(pending.await.unwrap().unwrap_err().contains("debug inspection expired"));
    assert_eq!(fixture.count("pl_debug_inspect"), 1);
    assert_eq!(fixture.count("business_dispatch"), 0);
}

#[tokio::test]
async fn inspect_type_preparation_is_not_replayed_after_a_recoverable_error() {
    for prepare_types in [true, false] {
        let fixture =
            Fixture::new_for_driver("inspect_recoverable_error", DatabaseType::OceanbaseOracle, "oceanbase-oracle")
                .await;
        let request = PlDebugInspect {
            connection_id: "conn".into(),
            database: "APP".into(),
            client_session_id: "preview".into(),
            target: Some(PlDebugInspectTarget {
                schema: "S".into(),
                object_type: "PROCEDURE".into(),
                object_name: "P".into(),
                package_name: "PKG".into(),
                metadata_preparation: prepare_types.then(|| "type_only".into()),
            }),
        };
        assert!(pl_debug_inspect_core(&fixture.state, &PlDebugAccess::desktop(), request).await.is_err());
        assert_eq!(fixture.count("pl_debug_inspect"), if prepare_types { 1 } else { 2 });
        assert_eq!(fixture.count("business_dispatch"), 0);
        let target = fixture.events().into_iter().find(|event| event["method"] == "inspect_entered").unwrap();
        if prepare_types {
            assert_eq!(target["target"]["metadataPreparation"], "type_only");
        } else {
            assert!(target["target"].get("metadataPreparation").is_none());
        }
    }
}

#[tokio::test]
async fn start_rejects_stale_preview_without_consuming_its_operation_identity() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let mut request = fixture.start_request("confirmed-start");
    request.expected_connection_revision =
        Some(connection_revision(fixture.state.pl_debug.epoch, &fixture.state.connection_lifecycle_snapshot("conn")));
    fixture.state.invalidate_connection_lifecycle("conn");
    assert!(pl_debug_start_core(&fixture.state, &access, request.clone())
        .err()
        .unwrap()
        .contains("changed after the debug preview"));
    assert!(fixture.state.pl_debug.lock().sessions.is_empty());
    assert_eq!(fixture.count("business_dispatch"), 0);
    request.expected_connection_revision =
        Some(connection_revision(fixture.state.pl_debug.epoch, &fixture.state.connection_lifecycle_snapshot("conn")));
    let started = pl_debug_start_core(&fixture.state, &access, request.clone()).unwrap();
    let reference = fixture.reference(&started);
    assert!(matches!(fixture.receipt(&access, &reference, "confirmed-start").await.state, OperationState::Succeeded));
    assert_eq!(fixture.count("business_dispatch"), 1);
    fixture.state.invalidate_connection_lifecycle("conn");
    assert_eq!(pl_debug_start_core(&fixture.state, &access, request).unwrap().session_id, started.session_id);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn connection_removal_waits_for_original_debug_cleanup_before_detaching_query_pools() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("remove-start")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "remove-start").await;
    fixture.idle_query_pool().await;
    let state = fixture.state.clone();
    let mut removal =
        tokio::spawn(async move { accepted_connection_change(&state, state.remove_connection_pools("conn")).await });
    tokio::select! {
        _ = &mut removal => panic!("connection removal completed before the original debugger cleanup"),
        _ = fixture.wait_event("close_entered") => {},
    }
    assert!(fixture.state.pool_handle("conn").await.is_some());
    assert!(!removal.is_finished());
    let mut new_start = fixture.start_request("during-remove");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(10), removal).await.unwrap().unwrap();
    assert!(fixture.state.pool_handle("conn").await.is_none());
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("process_exit"), 1);
    let status = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
    assert_eq!(status["releaseState"], "released");
}

#[tokio::test]
async fn connection_removal_variants_join_original_cleanup_even_after_config_deletion() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("removed-config")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "removed-config").await;
    fixture.idle_query_pool().await;
    fixture.state.configs.write().await.remove("conn");
    let first = fixture.state.clone();
    let detached = tokio::spawn(async move {
        accepted_connection_change(&first, first.remove_connection_pools_detached("conn")).await
    });
    fixture.wait_event("close_entered").await;
    let second = fixture.state.clone();
    let replacement = tokio::spawn(async move {
        accepted_connection_change(&second, second.drop_connection_pools_without_close("conn")).await
    });
    let third = fixture.state.clone();
    let removal =
        tokio::spawn(async move { accepted_connection_change(&third, third.remove_connection_pools("conn")).await });
    assert!(fixture.state.pool_handle("conn").await.is_some());
    assert!(!detached.is_finished());
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(10), async {
        detached.await.unwrap();
        replacement.await.unwrap();
        removal.await.unwrap();
    })
    .await
    .unwrap();
    assert!(fixture.state.pool_handle("conn").await.is_none());
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("process_exit"), 1);
}

#[tokio::test]
async fn cancelled_connection_removal_retains_its_fence_and_original_cleanup_for_retry() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("cancelled-removal")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "cancelled-removal").await;
    fixture.idle_query_pool().await;
    let state = fixture.state.clone();
    let removal =
        tokio::spawn(async move { accepted_connection_change(&state, state.remove_connection_pools("conn")).await });
    fixture.wait_event("close_entered").await;
    removal.abort();
    assert!(removal.await.unwrap_err().is_cancelled());
    let mut new_start = fixture.start_request("during-cancelled-removal");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    assert!(fixture.state.pool_handle("conn").await.is_some());
    fixture.release("close-gate");
    tokio::time::timeout(
        Duration::from_secs(10),
        accepted_connection_change(&fixture.state, fixture.state.remove_connection_pools("conn")),
    )
    .await
    .unwrap();
    assert!(fixture.state.pool_handle("conn").await.is_none());
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[tokio::test]
async fn connection_cleanup_records_its_original_drain_before_waiting_for_transport_mutation() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("queued-drain")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "queued-drain").await;
    fixture.idle_query_pool().await;
    let gate = fixture
        .state
        .pl_debug
        .lock()
        .connection_gates
        .entry("conn".into())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let held_mutation = gate.lock_owned().await;
    let state = fixture.state.clone();
    let removal =
        tokio::spawn(async move { accepted_connection_change(&state, state.remove_connection_pools("conn")).await });
    fixture.wait_event("close_entered").await;
    assert!(!removal.is_finished());
    let original = fixture.state.pl_debug.lock().connection_drains.get("conn").unwrap().intent.clone();
    assert!(!fixture.state.pl_debug.lock().connection_fences.contains_key("conn"));
    let mut new_start = fixture.start_request("during-queued-drain");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start.clone()).is_err());
    removal.abort();
    assert!(removal.await.unwrap_err().is_cancelled());
    let retained = fixture.state.pl_debug.lock().connection_drains.get("conn").unwrap().intent.clone();
    assert!(Arc::ptr_eq(&original, &retained));
    assert_eq!(original.deadline, retained.deadline);
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    assert!(fixture.state.pool_handle("conn").await.is_some());
    drop(held_mutation);
    fixture.release("close-gate");
    tokio::time::timeout(
        Duration::from_secs(10),
        accepted_connection_change(&fixture.state, fixture.state.remove_connection_pools("conn")),
    )
    .await
    .unwrap();
    assert!(fixture.state.pool_handle("conn").await.is_none());
    assert!(!fixture.state.pl_debug.lock().connection_drains.contains_key("conn"));
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[tokio::test]
async fn cancelled_protected_teardown_keeps_the_drain_after_debugger_exit_until_explicit_completion() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("teardown-scope")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "teardown-scope").await;
    {
        let permit = pl_debug_claim_mutation_core(
            &fixture.state,
            Some(&access),
            PlDebugMutationScope::Connections(vec!["conn".into()]),
        )
        .unwrap();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let operation = permit.after_debug_cleanup(async {
            entered.send(()).unwrap();
            std::future::pending::<Result<(), String>>().await
        });
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => panic!("teardown unexpectedly completed: {result:?}"),
            result = entered_rx => result.unwrap(),
        }
    }
    let status = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
    assert_eq!(status["runtimeExited"], true);
    assert_eq!(status["releaseState"], "released");
    let mut new_start = fixture.start_request("during-unfinished-teardown");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    assert!(fixture.state.pl_debug.lock().connection_drains.contains_key("conn"));
    accepted_connection_change(&fixture.state, async {}).await;
    assert!(!fixture.state.pl_debug.lock().connection_drains.contains_key("conn"));
    assert!(fixture.state.pl_debug.try_idle_fence("conn").is_some());
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[tokio::test]
async fn shared_connection_drain_stays_closed_until_the_last_accepted_teardown_completes() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("shared-drain-users")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "shared-drain-users").await;
    let (first_entered, first_entered_rx) = tokio::sync::oneshot::channel();
    let (finish_first, finish_first_rx) = tokio::sync::oneshot::channel();
    let state = fixture.state.clone();
    let first = tokio::spawn(async move {
        accepted_connection_change(&state, async {
            first_entered.send(()).unwrap();
            finish_first_rx.await.unwrap();
        })
        .await;
    });
    first_entered_rx.await.unwrap();
    let (entered, second_entered) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let state = fixture.state.clone();
    let second = tokio::spawn(async move {
        accepted_connection_change(&state, async {
            let _ = entered.send(());
            released.await.unwrap();
        })
        .await;
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if fixture.state.pl_debug.lock().connection_drains.get("conn").unwrap().users == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    finish_first.send(()).unwrap();
    first.await.unwrap();
    second_entered.await.unwrap();
    assert!(fixture.state.pl_debug.lock().connection_drains.contains_key("conn"));
    let mut new_start = fixture.start_request("during-second-teardown");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    release.send(()).unwrap();
    second.await.unwrap();
    assert!(!fixture.state.pl_debug.lock().connection_drains.contains_key("conn"));
    assert_eq!(fixture.count("pl_debug_close"), 1);
}

#[tokio::test]
async fn late_isolation_cannot_downgrade_a_confirmed_original_exit() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("late-isolation")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "late-isolation").await;
    fixture.close(&access, &reference).await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    let before = entry.view(fixture.state.pl_debug.epoch);
    assert_eq!(before["runtimeExited"], true);
    assert_eq!(before["releaseState"], "released");
    super::lifecycle::force_isolate(&entry, 1);
    assert_eq!(entry.view(fixture.state.pl_debug.epoch), before);
}

#[tokio::test]
async fn application_shutdown_keeps_transport_and_supervisor_until_original_debug_cleanup_finishes() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("application-close")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "application-close").await;
    let port = fixture.runtime_transport().await;
    let state = fixture.state.clone();
    let mut shutdown = tokio::spawn(async move { state.shutdown(Duration::from_secs(10)).await });
    tokio::select! {
        _ = &mut shutdown => panic!("application shutdown skipped original debugger cleanup"),
        _ = fixture.wait_event("close_entered") => {},
    }
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, Some(port));
    assert!(fixture.state.pl_debug_supervisor().spawn_once("cleanup-dependencies-still-open", |_| async {}));
    assert!(pl_debug_start_core(&fixture.state, &access, fixture.start_request("during-application-close")).is_err());
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(10), shutdown).await.unwrap().unwrap();
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, None);
    assert!(!fixture.state.pl_debug_supervisor().spawn_once("application-closed", |_| async {}));
    let status = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
    assert_eq!(status["runtimeExited"], true);
    assert_eq!(status["releaseState"], "released");
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("process_exit"), 1);
}

#[tokio::test]
async fn application_shutdown_shortens_original_close_without_restarting_or_claiming_release() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("application-deadline")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "application-deadline").await;
    fixture.runtime_transport().await;
    let close = fixture.operation(&access, &reference, "original-close", PlDebugAction::Close).await;
    pl_debug_operate_core(&fixture.state, &access, close).await.unwrap();
    fixture.wait_event("close_entered").await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    let channel = entry.lock().channel.clone().unwrap();
    let started = Instant::now();
    fixture.state.shutdown(Duration::from_millis(200)).await;
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(channel.wait_for_exit(Duration::from_secs(2)).await);
    let status = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
    assert_eq!(status["releaseState"], "unknown");
    assert_ne!(status["executionStopped"], true);
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, None);
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("process_exit"), 0);
}

#[tokio::test]
async fn application_shutdown_does_not_grant_a_fresh_global_budget_after_debug_cleanup() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("shared-budget")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "shared-budget").await;
    let (finished, task_finished) = tokio::sync::oneshot::channel::<()>();
    fixture.state.pl_debug_supervisor().spawn_once("application-budget-fixture", |_| async move {
        let _finished = finished;
        std::future::pending::<()>().await;
    });
    let state = fixture.state.clone();
    let started = Instant::now();
    let shutdown = tokio::spawn(async move { state.shutdown(Duration::from_secs(2)).await });
    fixture.wait_event("close_entered").await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(4), shutdown).await.unwrap().unwrap();
    assert!(started.elapsed() < Duration::from_millis(2500));
    assert!(tokio::time::timeout(Duration::from_secs(1), task_finished).await.unwrap().is_err());
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("process_exit"), 1);
}

#[tokio::test]
async fn transport_publication_rechecks_client_attempt_after_waiting_for_the_gate() {
    let fixture = Fixture::new("normal").await;
    let config = fixture.state.configs.read().await["conn"].clone();
    let attempt = fixture.state.begin_connection_attempt("conn").await;
    let endpoint = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    endpoint.endpoint.unwrap();
    let gate = fixture.state.pl_debug.lock().connection_gates["conn"].clone();
    let held = gate.lock_owned().await;
    let state = fixture.state.clone();
    let (started, queued) = tokio::sync::oneshot::channel();
    let publication = tokio::spawn(async move {
        let _ = started.send(());
        state
            .insert_connection_pool_for_attempt_with_transport(
                "conn",
                attempt,
                "conn".into(),
                crate::connection::PoolKind::Nacos,
                &config,
                &endpoint.stamp,
            )
            .await
    });
    queued.await.unwrap();
    assert!(!publication.is_finished());
    fixture.state.begin_connection_attempt("conn").await;
    drop(held);
    assert!(publication.await.unwrap().is_err());
    assert!(fixture.state.pool_handle("conn").await.is_none());
    fixture.state.reset_connection_transport("conn").await;
}

#[tokio::test]
async fn transport_debug_start_binds_its_original_stamp_before_partial_manager_work() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ready, accepted) = tokio::sync::oneshot::channel();
    let upstream = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        let _ = ready.send(());
        std::future::pending::<()>().await;
    });
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = serde_json::from_value(json!([
        {"type":"proxy","id":"proxy","host":"127.0.0.1","port":port},
        {"type":"ssh","id":"ssh","host":"127.0.0.1","port":22,"user":"fixture","connect_timeout_secs":10}
    ]))
    .unwrap();
    fixture.state.configs.write().await.insert("conn".into(), config);
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("partial-stamp")).unwrap();
    let reference = fixture.reference(&started);
    tokio::time::timeout(Duration::from_secs(5), accepted).await.unwrap().unwrap();
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    let bound = entry.lock().transport_stamp.clone().expect("partial work must retain its original stamp");
    assert!(bound.same_token(&super::current_transport(&fixture.state, "conn").unwrap()));
    assert!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await.is_some());
    upstream.abort();
    let _ = upstream.await;
    let result = fixture.receipt(&access, &reference, "partial-stamp").await;
    assert!(matches!(result.state, OperationState::Failed));
    assert_eq!(fixture.count("business_dispatch"), 0);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let notified = entry.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if entry.lock().close.as_ref().is_some_and(|close| close.done) {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, None);
}

#[tokio::test]
async fn transport_partial_start_returns_original_stamp_and_retry_retires_its_layers() {
    let fixture = Fixture::new("normal").await;
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = serde_json::from_value(json!([
        {"type":"proxy","id":"proxy","host":"127.0.0.1","port":config.port},
        {"type":"ssh","id":"ssh","host":"127.0.0.1","port":22,"user":"fixture","connect_timeout_secs":1}
    ]))
    .unwrap();
    let first =
        tokio::time::timeout(Duration::from_secs(5), fixture.state.connection_endpoint_attempt("conn", &config))
            .await
            .unwrap()
            .unwrap();
    assert!(first.endpoint.is_err());
    assert!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await.is_some());
    config.transport_layers.truncate(1);
    let retry = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    let port = retry.endpoint.unwrap().port;
    assert!(!first.stamp.same_runtime(&retry.stamp));
    fixture.state.reset_connection_transport_if_current("conn", &first.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    fixture.state.reset_connection_transport_if_current("conn", &retry.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, None);
}

#[tokio::test]
async fn transport_cancelled_partial_start_cannot_be_adopted_as_a_ready_runtime() {
    let fixture = Fixture::new("normal").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ready, accepted) = tokio::sync::oneshot::channel();
    let upstream = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        let _ = ready.send(());
        std::future::pending::<()>().await;
    });
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = serde_json::from_value(json!([
        {"type":"proxy","id":"proxy","host":"127.0.0.1","port":port},
        {"type":"ssh","id":"ssh","host":"127.0.0.1","port":22,"user":"fixture","connect_timeout_secs":10}
    ]))
    .unwrap();
    let state = fixture.state.clone();
    let first_config = config.clone();
    let first = tokio::spawn(async move { state.connection_endpoint_attempt("conn", &first_config).await });
    tokio::time::timeout(Duration::from_secs(5), accepted).await.unwrap().unwrap();
    let original = super::current_transport(&fixture.state, "conn").unwrap();
    first.abort();
    match first.await {
        Err(error) => assert!(error.is_cancelled()),
        Ok(_) => panic!("the blocked endpoint completed before cancellation"),
    }
    config.transport_layers.truncate(1);
    let retry = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    let port = retry.endpoint.unwrap().port;
    assert!(!original.same_runtime(&retry.stamp));
    fixture.state.reset_connection_transport_if_current("conn", &original).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    fixture.state.reset_connection_transport_if_current("conn", &retry.stamp).await;
    upstream.abort();
    let _ = upstream.await;
}

#[tokio::test]
async fn transport_pending_starts_bind_before_waiting_for_the_same_gate() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let gate = fixture
        .state
        .pl_debug
        .lock()
        .connection_gates
        .entry("conn".into())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let held = gate.lock_owned().await;
    let first = pl_debug_start_core(&fixture.state, &access, fixture.start_request("first-pending-plan")).unwrap();
    let first_reference = fixture.reference(&first);
    let mut second_start = fixture.start_request("second-pending-plan");
    second_start.client_session_id = "other-editor".into();
    let second = pl_debug_start_core(&fixture.state, &access, second_start).unwrap();
    let mut second_reference = fixture.reference(&second);
    second_reference.client_session_id = "other-editor".into();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fixture
                .state
                .pl_debug
                .lock()
                .sessions
                .values()
                .filter(|entry| entry.lock().transport_plan.is_some())
                .count()
                == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let state = fixture.state.clone();
    let config = state.configs.read().await["conn"].clone();
    let ordinary = tokio::spawn(async move { state.connection_endpoint_attempt("conn", &config).await });
    drop(held);
    let first = fixture.receipt(&access, &first_reference, "first-pending-plan").await;
    let second = fixture.receipt(&access, &second_reference, "second-pending-plan").await;
    assert!(matches!(first.state, OperationState::Succeeded));
    assert!(matches!(second.state, OperationState::Succeeded));
    tokio::time::timeout(Duration::from_secs(5), ordinary).await.unwrap().unwrap().unwrap().endpoint.unwrap();
    fixture.close(&access, &first_reference).await;
    fixture.close(&access, &second_reference).await;
    fixture.state.reset_connection_transport("conn").await;
}

#[tokio::test]
async fn transport_same_plan_adoption_reuses_listener_but_invalidates_old_cleanup() {
    let fixture = Fixture::new("normal").await;
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"proxy","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    let first = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    let port = first.endpoint.unwrap().port;
    let second = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    assert_eq!(second.endpoint.unwrap().port, port);
    assert!(!first.stamp.same_token(&second.stamp));
    fixture.state.reset_connection_transport_if_current("conn", &first.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    fixture.state.reset_connection_transport_if_current("conn", &second.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, None);
}

#[tokio::test]
async fn transport_changed_plan_replaces_listener_without_adopting_late_cleanup() {
    let fixture = Fixture::new("normal").await;
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"proxy","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    let first = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    first.endpoint.unwrap();
    config.host = "127.0.0.2".into();
    let second = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    let port = second.endpoint.unwrap().port;
    fixture.state.reset_connection_transport_if_current("conn", &first.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    fixture.state.reset_connection_transport_if_current("conn", &second.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, None);
}

#[tokio::test]
async fn transport_oci_launch_uses_the_original_settings_and_protects_the_same_frozen_identity() {
    let fixture = Fixture::new("capture_env").await;
    let access = PlDebugAccess::desktop();
    let driver = fixture.state.agent_manager.driver_dir("oracle-oci");
    std::fs::create_dir_all(&driver).unwrap();
    std::fs::write(
        fixture.state.agent_manager.driver_launch_config_path("oracle-oci"),
        json!({
            "command":if cfg!(windows) {"python"} else {"python3"},
            "args":[fixture.state.agent_manager.driver_dir("oracle").join("agent.py")],
            "working_dir":"{driver_dir}"
        })
        .to_string(),
    )
    .unwrap();
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.driver_profile = Some(crate::oracle_oci::ORACLE_OCI_DRIVER_PROFILE.into());
    fixture.state.configs.write().await.insert("conn".into(), config.clone());
    fixture
        .state
        .storage
        .save_editor_settings(
            &json!({"oracleOciTnsAdmin":"fixture-original-wallet","oracleOciNlsLang":"AMERICAN_AMERICA.AL32UTF8"}),
        )
        .await
        .unwrap();
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    fixture.state.pl_debug.lock().connection_gates.insert("conn".into(), gate.clone());
    let held = gate.lock_owned().await;
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("oci-frozen-settings")).unwrap();
    let reference = fixture.reference(&started);
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let notified = fixture.state.pl_debug.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if entry.lock().transport_plan.is_some() {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap();
    fixture
        .state
        .storage
        .save_editor_settings(
            &json!({"oracleOciTnsAdmin":"fixture-new-wallet","oracleOciNlsLang":"SIMPLIFIED CHINESE_CHINA.AL32UTF8"}),
        )
        .await
        .unwrap();
    drop(held);
    assert!(matches!(
        fixture.receipt(&access, &reference, "oci-frozen-settings").await.state,
        OperationState::Succeeded
    ));
    let env = fixture.events().into_iter().find(|event| event["method"] == "launch_env").unwrap();
    let changed = fixture.state.connection_endpoint_attempt("conn", &config).await;
    fixture.close(&access, &reference).await;
    fixture.state.reset_connection_transport("conn").await;
    assert_eq!(env["tns_admin"], "fixture-original-wallet");
    assert_eq!(env["nls_lang"], "AMERICAN_AMERICA.AL32UTF8");
    assert!(changed.is_err(), "different effective OCI settings were treated as the original protected transport");
}

#[tokio::test]
async fn transport_failed_ordinary_adoption_cannot_close_a_protected_debugger() {
    let fixture = Fixture::new("normal").await;
    let access = PlDebugAccess::desktop();
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"proxy","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    fixture.state.configs.write().await.insert("conn".into(), config.clone());
    let started = pl_debug_start_core(&fixture.state, &access, fixture.start_request("reuse-protected")).unwrap();
    let reference = fixture.reference(&started);
    assert!(matches!(fixture.receipt(&access, &reference, "reuse-protected").await.state, OperationState::Succeeded));
    let attempt = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    let port = attempt.endpoint.unwrap().port;
    fixture.state.reset_connection_transport_if_current("conn", &attempt.stamp).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    assert_eq!(fixture.count("pl_debug_close"), 0);
    fixture.close(&access, &reference).await;
    let remaining = fixture.state.proxy_tunnels.local_port("conn:transport:0").await;
    fixture.state.reset_connection_transport("conn").await;
    assert_eq!(remaining, None, "the failed ordinary adopter left the debugger without transport cleanup ownership");
}

#[tokio::test]
async fn transport_failed_adoption_passes_cleanup_between_the_original_protected_debuggers() {
    let fixture = Fixture::new("normal").await;
    let first_owner = PlDebugAccess::web("first-owner".into()).unwrap();
    let second_owner = PlDebugAccess::web("second-owner".into()).unwrap();
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"proxy","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    fixture.state.configs.write().await.insert("conn".into(), config.clone());
    let started = pl_debug_start_core(&fixture.state, &first_owner, fixture.start_request("first-adopter")).unwrap();
    let first = fixture.reference(&started);
    assert!(matches!(fixture.receipt(&first_owner, &first, "first-adopter").await.state, OperationState::Succeeded));
    let mut request = fixture.start_request("second-adopter");
    request.client_session_id = "second-editor".into();
    let started = pl_debug_start_core(&fixture.state, &second_owner, request).unwrap();
    let second = PlDebugSessionRef { client_session_id: "second-editor".into(), ..fixture.reference(&started) };
    assert!(matches!(fixture.receipt(&second_owner, &second, "second-adopter").await.state, OperationState::Succeeded));
    let attempt = fixture.state.connection_endpoint_attempt("conn", &config).await.unwrap();
    let port = attempt.endpoint.unwrap().port;
    fixture.state.reset_connection_transport_if_current("conn", &attempt.stamp).await;
    assert_eq!(fixture.count("pl_debug_close"), 0);
    fixture.close(&first_owner, &first).await;
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    assert_eq!(fixture.count("pl_debug_close"), 1);
    fixture.close(&second_owner, &second).await;
    let remaining = fixture.state.proxy_tunnels.local_port("conn:transport:0").await;
    fixture.state.reset_connection_transport("conn").await;
    assert_eq!(remaining, None);
}

#[tokio::test]
async fn transport_reset_remembers_started_layers_after_configuration_is_deleted() {
    let fixture = Fixture::new("normal").await;
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"proxy","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    fixture.state.configs.write().await.insert("conn".into(), config.clone());
    let (_, port) = fixture.state.connection_host_port("conn", &config).await.unwrap();
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn:transport:0").await, Some(port));
    fixture.state.configs.write().await.remove("conn");
    fixture.state.reset_connection_transport("conn").await;
    let listener = fixture.state.proxy_tunnels.local_port("conn:transport:0").await;
    assert!(listener.is_none(), "the original layer survived after its configuration was deleted");
}

#[tokio::test]
async fn ordinary_endpoint_preparation_cannot_replace_a_protected_debuggers_actual_transport() {
    let fixture = Fixture::new("normal").await;
    let owner = PlDebugAccess::desktop();
    let mut config = fixture.state.configs.read().await["conn"].clone();
    config.transport_layers = vec![serde_json::from_value(json!({
        "type":"proxy","id":"proxy","host":"127.0.0.1","port":65000
    }))
    .unwrap()];
    fixture.state.configs.write().await.insert("conn".into(), config.clone());
    let started = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("protected-transport")).unwrap();
    let reference = fixture.reference(&started);
    fixture.receipt(&owner, &reference, "protected-transport").await;
    let original_port = fixture.state.proxy_tunnels.local_port("conn:transport:0").await.unwrap();
    let mut changed = config.clone();
    changed.host = "127.0.0.2".into();
    let result = fixture.state.connection_host_port("conn", &changed).await;
    let retained_port = fixture.state.proxy_tunnels.local_port("conn:transport:0").await;
    let closes = fixture.count("pl_debug_close");
    fixture.close(&owner, &reference).await;
    fixture.state.reset_connection_transport_for_config("conn", &config).await;
    assert!(result.is_err(), "ordinary preparation reused or replaced a different protected target");
    assert_eq!(retained_port, Some(original_port));
    assert_eq!(closes, 0);
}

#[tokio::test]
async fn transport_reset_waits_for_the_original_debugger_before_stopping_its_listener() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("transport-reset")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "transport-reset").await;
    let port = fixture.runtime_transport().await;
    let state = fixture.state.clone();
    let mut reset =
        tokio::spawn(async move { accepted_connection_change(&state, state.reset_connection_transport("conn")).await });
    tokio::select! {
        _ = &mut reset => panic!("transport reset completed before original debugger cleanup"),
        _ = fixture.wait_event("close_entered") => {},
    }
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, Some(port));
    let mut new_start = fixture.start_request("during-transport-reset");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(10), reset).await.unwrap().unwrap();
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, None);
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("process_exit"), 1);
}

#[tokio::test]
async fn cancelled_transport_reset_retains_the_listener_and_rejoins_original_cleanup() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("cancel-reset")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&access, &reference, "cancel-reset").await;
    let port = fixture.runtime_transport().await;
    let state = fixture.state.clone();
    let reset =
        tokio::spawn(async move { accepted_connection_change(&state, state.reset_connection_transport("conn")).await });
    fixture.wait_event("close_entered").await;
    reset.abort();
    assert!(reset.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, Some(port));
    let mut new_start = fixture.start_request("after-cancel-reset");
    new_start.client_session_id = "another-editor".into();
    assert!(pl_debug_start_core(&fixture.state, &access, new_start).is_err());
    fixture.release("close-gate");
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let notified = entry.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if entry.lock().close.as_ref().is_some_and(|close| close.done) {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, Some(port));
    assert!(fixture.state.pl_debug.lock().connection_drains.contains_key("conn"));
    tokio::time::timeout(
        Duration::from_secs(10),
        accepted_connection_change(&fixture.state, fixture.state.reset_connection_transport("conn")),
    )
    .await
    .unwrap();
    assert_eq!(fixture.state.proxy_tunnels.local_port("conn").await, None);
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[tokio::test]
async fn legacy_and_helper_agents_are_rejected_before_open_session_or_any_debug_call() {
    for mode in ["legacy", "helper"] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let receipt = pl_debug_start_core(&fixture.state, &access, fixture.start_request("old-agent")).unwrap();
        let reference = fixture.reference(&receipt);
        let result = fixture.receipt(&access, &reference, "old-agent").await;
        assert!(matches!(result.state, OperationState::Failed));
        assert_eq!(result.error.unwrap()["code"], "native_agent_required");
        assert_eq!(fixture.count("open_session"), 0);
        assert_eq!(fixture.count("business_dispatch"), 0);
        assert!(!fixture.events().iter().any(|event| event["method"].as_str().unwrap().starts_with("pl_debug_")));
    }
}

#[tokio::test]
async fn owner_connection_client_and_epoch_are_checked_before_every_access() {
    let fixture = Fixture::new("native").await;
    let owner = PlDebugAccess::web("browser-one".into()).unwrap();
    let other = PlDebugAccess::web("browser-two".into()).unwrap();
    let receipt = pl_debug_start_core(&fixture.state, &owner, fixture.start_request("bound-start")).unwrap();
    let reference = fixture.reference(&receipt);
    fixture.receipt(&owner, &reference, "bound-start").await;
    let before = fixture.events().len();
    for access in [&other, &PlDebugAccess::desktop()] {
        assert_eq!(pl_debug_status_core(&fixture.state, access, &reference, true).await.err().unwrap(), INACCESSIBLE);
        assert!(pl_debug_heartbeat_core(&fixture.state, access, &reference).await.is_err());
        assert!(pl_debug_operation_core(&fixture.state, access, &reference, "bound-start").is_err());
        assert!(pl_debug_list_core(&fixture.state, access, reference.server_epoch, "conn").unwrap().is_empty());
        let operation = fixture.operation(&owner, &reference, "forbidden-close", PlDebugAction::Close).await;
        assert!(pl_debug_operate_core(&fixture.state, access, operation).await.is_err());
        assert!(pl_debug_read_core(
            &fixture.state,
            access,
            PlDebugRead {
                session: reference.clone(),
                generation: 1,
                stop_revision: Some(1),
                kind: PlDebugReadKind::Variables,
                params: json!({})
            }
        )
        .await
        .is_err());
    }
    for key in ["connection", "client", "epoch"] {
        let mut wrong = reference.clone();
        match key {
            "connection" => wrong.connection_id = "other".into(),
            "client" => wrong.client_session_id = "other".into(),
            _ => wrong.server_epoch = Uuid::new_v4(),
        }
        assert!(pl_debug_status_core(&fixture.state, &owner, &wrong, true).await.is_err());
    }
    assert_eq!(fixture.events().len(), before);
    fixture.close(&owner, &reference).await;
}

#[tokio::test]
async fn abort_does_not_wait_for_continue_and_late_continue_cannot_overwrite_its_stop() {
    let fixture = Fixture::new("late_resume").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    let resume = fixture.operation(&access, &reference, "resume", PlDebugAction::Resume).await;
    pl_debug_operate_core(&fixture.state, &access, resume.clone()).await.unwrap();
    fixture.wait_event("resume_entered").await;
    let busy = fixture.operation(&access, &reference, "step-busy", PlDebugAction::StepOver).await;
    assert!(pl_debug_operate_core(&fixture.state, &access, busy).await.is_err());
    pl_debug_operate_core(&fixture.state, &access, resume).await.unwrap();
    assert_eq!(fixture.count("pl_debug_resume"), 1);
    let abort = fixture.operation(&access, &reference, "abort", PlDebugAction::Abort).await;
    pl_debug_operate_core(&fixture.state, &access, abort).await.unwrap();
    fixture.receipt(&access, &reference, "abort").await;
    let ended = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
    assert_eq!(ended["executionOutcome"], "cancelled");
    fixture.release("resume-gate");
    fixture.receipt(&access, &reference, "resume").await;
    let after = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap();
    assert_eq!(after["executionOutcome"], "cancelled");
    assert_eq!(after["executionStopped"], true);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn execute_receipts_validate_results_without_changing_legacy_success() {
    for (mode, expected) in [
        ("execute_success", OperationState::Succeeded),
        ("execute_legacy_success", OperationState::Succeeded),
        ("execute_rejected", OperationState::Failed),
        ("execute_partial", OperationState::Succeeded),
        ("execute_failed_partial", OperationState::Failed),
        ("execute_invalid", OperationState::Unknown),
        ("execute_legacy_lost", OperationState::Unknown),
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("execute-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "execute-start").await;
        let mut request = fixture.operation(&access, &reference, "execute", PlDebugAction::Execute).await;
        request.params =
            json!({"operationId":"spoofed","debugId":"spoofed","sql":"BEGIN :1 := rows; END;","maxRows":3});
        pl_debug_operate_core(&fixture.state, &access, request.clone()).await.unwrap();
        let receipt = fixture.receipt(&access, &reference, "execute").await;
        assert!(receipt.state == expected, "{mode}");
        if expected != OperationState::Unknown {
            let result = receipt.result.as_ref().unwrap();
            assert!(result["rows"][0].is_null());
            assert_eq!(result["rows"][1], "");
            if mode.ends_with("partial") {
                assert_eq!(result["complete"], false);
                assert_eq!(result["resultError"], "Original result capture incomplete");
            }
        }
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        assert_eq!(fixture.count("pl_debug_execute"), 1);
        let binding = fixture.events().into_iter().find(|event| event["method"] == "execute_binding").unwrap();
        assert_eq!(binding["operationId"], "execute");
        assert_eq!(binding["stopRevision"], 1);
        let refreshed = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
        if mode == "execute_legacy_lost" {
            assert_eq!(fixture.count("pl_debug_operation_status"), 0);
            assert_eq!(refreshed["state"], "unknown");
        }
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn execute_recovery_uses_original_id_without_replaying_sql() {
    let fixture = Fixture::new("execute_lost").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("execute-start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "execute-start").await;
    let mut request = fixture.operation(&access, &reference, "execute", PlDebugAction::Execute).await;
    request.params = json!({"sql":"BEGIN :1 := rows; END;","stopRevision":1});
    pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
    assert!(fixture.receipt(&access, &reference, "execute").await.state == OperationState::Unknown);
    let refreshed = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
    assert!(
        pl_debug_operation_core(&fixture.state, &access, &reference, "execute").unwrap().state
            == OperationState::Succeeded
    );
    assert_eq!(refreshed["state"], "paused");
    assert_eq!(fixture.count("pl_debug_execute"), 1);
    assert_eq!(fixture.count("pl_debug_operation_status"), 1);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn execute_recovery_preserves_confirmed_prepare_failure_without_replay() {
    for (mode, expected) in [
        ("execute_prepare_lost", OperationState::Failed),
        ("execute_prepare_wrong_stop_lost", OperationState::Unknown),
        ("execute_prepare_unknown_lost", OperationState::Unknown),
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("execute-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "execute-start").await;
        let mut request = fixture.operation(&access, &reference, "execute", PlDebugAction::Execute).await;
        request.params = json!({"sql":"BEGIN NULL; END;","stopRevision":1});
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        assert!(fixture.receipt(&access, &reference, "execute").await.state == OperationState::Unknown);
        pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
        let receipt = pl_debug_operation_core(&fixture.state, &access, &reference, "execute").unwrap();
        assert!(receipt.state == expected, "{mode}");
        if expected == OperationState::Failed {
            assert_eq!(receipt.error.as_ref().unwrap()["operationOutcome"], "not_started");
            assert!(receipt.result.is_none());
        }
        assert_eq!(fixture.count("pl_debug_execute"), 1);
        assert_eq!(fixture.count("pl_debug_operation_status"), 1);
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn assignment_receipts_preserve_native_failure_and_trusted_identity() {
    for (mode, expected) in [
        ("assignment_success", OperationState::Succeeded),
        ("assignment_rejected", OperationState::Failed),
        ("assignment_invalid", OperationState::Unknown),
        ("assignment_legacy", OperationState::Unknown),
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("assignment-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "assignment-start").await;
        let mut request = fixture.operation(&access, &reference, "assignment", PlDebugAction::SetValue).await;
        request.params =
            json!({"operationId":"spoofed","debugId":"spoofed","stopRevision":1,"frame":0,"name":"N","value":"9"});
        pl_debug_operate_core(&fixture.state, &access, request.clone()).await.unwrap();
        let receipt = fixture.receipt(&access, &reference, "assignment").await;
        assert!(receipt.state == expected);
        if mode == "assignment_rejected" {
            assert_eq!(receipt.result.as_ref().unwrap()["result"], 77);
            assert!(receipt.error.is_none());
            assert_eq!(receipt.result.as_ref().unwrap()["snapshot"]["executionOutcome"], "pending");
        }
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        let binding = fixture.events().into_iter().find(|event| event["method"] == "assignment_binding").unwrap();
        assert_eq!(binding["operationId"], "assignment");
        let original_agent = fixture.events().into_iter().find(|event| event["method"] == "business_dispatch").unwrap()
            ["operationId"]
            .clone();
        assert_eq!(binding["debugId"], original_agent);
        assert_eq!(binding["stopRevision"], 1);
        assert_eq!(fixture.count("pl_debug_set_value"), 1);
        let refreshed = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
        if mode == "assignment_legacy" {
            assert_eq!(fixture.count("pl_debug_operation_status"), 0);
            assert_eq!(refreshed["state"], "unknown");
        }
        if mode == "assignment_invalid" {
            assert!(
                pl_debug_operation_core(&fixture.state, &access, &reference, "assignment").unwrap().state
                    == OperationState::Unknown
            );
        }
        if mode == "assignment_rejected" {
            let step = fixture.operation(&access, &reference, "step-after-reject", PlDebugAction::StepOver).await;
            pl_debug_operate_core(&fixture.state, &access, step).await.unwrap();
            assert!(fixture.receipt(&access, &reference, "step-after-reject").await.state == OperationState::Succeeded);
        }
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn assignment_recovery_reads_original_result_without_replay_or_late_snapshot_overwrite() {
    for mode in ["assignment_lost", "assignment_late"] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("assignment-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "assignment-start").await;
        let mut request = fixture.operation(&access, &reference, "assignment", PlDebugAction::SetValue).await;
        request.params = json!({"stopRevision":1,"frame":0,"name":"N","value":"9"});
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        assert!(fixture.receipt(&access, &reference, "assignment").await.state == OperationState::Unknown);
        let state = fixture.state.clone();
        let refresh_access = access.clone();
        let refresh_reference = reference.clone();
        let refresh =
            tokio::spawn(async move { pl_debug_status_core(&state, &refresh_access, &refresh_reference, true).await });
        fixture.wait_event("assignment_recovery_entered").await;
        assert!(
            pl_debug_operation_core(&fixture.state, &access, &reference, "assignment").unwrap().state
                == OperationState::Unknown
        );
        assert_eq!(pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap()["state"], "unknown");
        if mode == "assignment_late" {
            let abort = fixture.operation(&access, &reference, "abort", PlDebugAction::Abort).await;
            pl_debug_operate_core(&fixture.state, &access, abort).await.unwrap();
            fixture.receipt(&access, &reference, "abort").await;
        }
        fixture.release("assignment-recovery-gate");
        let refreshed = refresh.await.unwrap().unwrap();
        assert!(
            pl_debug_operation_core(&fixture.state, &access, &reference, "assignment").unwrap().state
                == OperationState::Succeeded
        );
        assert_eq!(refreshed["state"], if mode == "assignment_late" { "ended" } else { "paused" });
        assert_eq!(fixture.count("pl_debug_set_value"), 1);
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn breakpoint_receipts_classify_native_results_without_changing_legacy_admission() {
    for (mode, action, expected) in [
        ("breakpoint_success", PlDebugAction::SetBreakpoints, OperationState::Succeeded),
        ("breakpoint_success", PlDebugAction::DeleteBreakpoints, OperationState::Succeeded),
        ("breakpoint_success", PlDebugAction::SetBreakpointEnabled, OperationState::Succeeded),
        ("breakpoint_rejected", PlDebugAction::SetBreakpoints, OperationState::Failed),
        ("breakpoint_invalid", PlDebugAction::DeleteBreakpoints, OperationState::Unknown),
        ("breakpoint_wrong_id", PlDebugAction::SetBreakpointEnabled, OperationState::Unknown),
        ("breakpoint_legacy", PlDebugAction::SetBreakpoints, OperationState::Succeeded),
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("breakpoint-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "breakpoint-start").await;
        let mut request = fixture.operation(&access, &reference, "breakpoint-command", action).await;
        if mode != "breakpoint_legacy" {
            request.params = json!({"stopRevision":99});
            assert!(pl_debug_operate_core(&fixture.state, &access, request.clone()).await.is_err());
            assert_eq!(fixture.count(action.method()), 0);
            request.params = json!({"stopRevision":1,"operationId":"spoofed","debugId":"spoofed"});
        }
        pl_debug_operate_core(&fixture.state, &access, request.clone()).await.unwrap();
        let receipt = fixture.receipt(&access, &reference, "breakpoint-command").await;
        assert!(receipt.state == expected, "{mode}");
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        assert_eq!(fixture.count(action.method()), 1);
        let binding = fixture.events().into_iter().find(|event| event["method"] == "breakpoint_binding").unwrap();
        assert_eq!(binding["operationId"], "breakpoint-command");
        assert_ne!(binding["debugId"], "spoofed");
        if expected == OperationState::Unknown {
            let refreshed = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
            assert_eq!(refreshed["state"], "unknown");
            assert!(
                pl_debug_operation_core(&fixture.state, &access, &reference, "breakpoint-command").unwrap().state
                    == OperationState::Unknown
            );
        }
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn breakpoint_legacy_requests_freeze_the_admitted_stop_without_changing_request_identity() {
    for (action, params) in [
        (PlDebugAction::SetBreakpoints, json!({"breakpoints":[]})),
        (PlDebugAction::DeleteBreakpoints, json!({"breakpoints":[]})),
        (PlDebugAction::SetBreakpointEnabled, json!({"breakpointNumber":1,"enabled":false})),
    ] {
        let fixture = Fixture::new("breakpoint_success").await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("legacy-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "legacy-start").await;
        let mut request = fixture.operation(&access, &reference, "legacy-command", action).await;
        request.params = params;
        pl_debug_operate_core(&fixture.state, &access, request.clone()).await.unwrap();
        assert!(fixture.receipt(&access, &reference, "legacy-command").await.state == OperationState::Succeeded);
        let binding = fixture.events().into_iter().find(|event| event["method"] == "breakpoint_binding").unwrap();
        assert_eq!(binding["stopRevision"], 1);
        let step = fixture.operation(&access, &reference, "step", PlDebugAction::StepOver).await;
        pl_debug_operate_core(&fixture.state, &access, step).await.unwrap();
        fixture.receipt(&access, &reference, "step").await;
        pl_debug_operate_core(&fixture.state, &access, request.clone()).await.unwrap();
        assert_eq!(fixture.count(action.method()), 1);
        request.operation_id = "malformed-flat".into();
        request.expected_revision = pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap()
            ["revision"]
            .as_u64()
            .unwrap();
        request.params["sourceRefId"] = json!("source");
        assert!(pl_debug_operate_core(&fixture.state, &access, request).await.is_err());
        assert_eq!(fixture.count(action.method()), 1);
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn breakpoint_predispatch_recovery_keeps_unknown_inventory_and_rejects_contradictions() {
    for mode in [
        "breakpoint_predispatch",
        "breakpoint_predispatch_partial",
        "breakpoint_predispatch_wrong_stop",
        "breakpoint_predispatch_wrong_action",
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("rejection-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "rejection-start").await;
        let mut request =
            fixture.operation(&access, &reference, "rejected-command", PlDebugAction::SetBreakpoints).await;
        request.params = json!({"breakpoints":[]});
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        assert!(fixture.receipt(&access, &reference, "rejected-command").await.state == OperationState::Unknown);
        let view = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
        let receipt = pl_debug_operation_core(&fixture.state, &access, &reference, "rejected-command").unwrap();
        if mode == "breakpoint_predispatch" {
            assert!(receipt.state == OperationState::Failed);
            assert_eq!(receipt.error.unwrap()["operationOutcome"], "not_started");
        } else {
            assert!(receipt.state == OperationState::Unknown, "{mode}");
        }
        assert_eq!(view["state"], "unknown");
        assert_eq!(view["breakpointInventoryState"], "unknown");
        assert_eq!(fixture.count("pl_debug_set_breakpoints"), 1);
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn breakpoint_recovery_queries_original_action_and_never_overwrites_later_abort() {
    for (mode, action) in [
        ("breakpoint_lost", PlDebugAction::SetBreakpoints),
        ("breakpoint_lost", PlDebugAction::DeleteBreakpoints),
        ("breakpoint_late", PlDebugAction::SetBreakpointEnabled),
    ] {
        let fixture = Fixture::new(mode).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("breakpoint-start")).unwrap();
        let reference = fixture.reference(&start);
        fixture.receipt(&access, &reference, "breakpoint-start").await;
        let mut request = fixture.operation(&access, &reference, "breakpoint-command", action).await;
        request.params = json!({"stopRevision":1});
        pl_debug_operate_core(&fixture.state, &access, request).await.unwrap();
        assert!(fixture.receipt(&access, &reference, "breakpoint-command").await.state == OperationState::Unknown);
        let state = fixture.state.clone();
        let refresh_access = access.clone();
        let refresh_reference = reference.clone();
        let refresh =
            tokio::spawn(async move { pl_debug_status_core(&state, &refresh_access, &refresh_reference, true).await });
        fixture.wait_event("assignment_recovery_entered").await;
        assert_eq!(pl_debug_status_core(&fixture.state, &access, &reference, false).await.unwrap()["state"], "unknown");
        if mode == "breakpoint_late" {
            let abort = fixture.operation(&access, &reference, "abort", PlDebugAction::Abort).await;
            pl_debug_operate_core(&fixture.state, &access, abort).await.unwrap();
            fixture.receipt(&access, &reference, "abort").await;
        }
        fixture.release("assignment-recovery-gate");
        let refreshed = refresh.await.unwrap().unwrap();
        assert!(
            pl_debug_operation_core(&fixture.state, &access, &reference, "breakpoint-command").unwrap().state
                == OperationState::Succeeded
        );
        assert_eq!(refreshed["state"], if mode == "breakpoint_late" { "ended" } else { "paused" });
        assert_eq!(fixture.count(action.method()), 1);
        fixture.close(&access, &reference).await;
    }
}

#[tokio::test]
async fn paused_reads_forward_the_trusted_stop_and_original_agent_identity() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("read-binding")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "read-binding").await;
    for kind in [PlDebugReadKind::Variables, PlDebugReadKind::Value, PlDebugReadKind::Stack] {
        let result = pl_debug_read_core(
            &fixture.state,
            &access,
            PlDebugRead {
                session: reference.clone(),
                generation: 1,
                stop_revision: Some(1),
                kind,
                params: json!({"frame":2,"name":"N","stopRevision":999,"debugId":"other-session"}),
            },
        )
        .await
        .unwrap();
        assert_eq!(result["stopRevision"], 1);
        assert_eq!(result["frame"], 2);
    }
    let bindings: Vec<_> = fixture.events().into_iter().filter(|event| event["method"] == "read_binding").collect();
    let original_agent = fixture.events().into_iter().find(|event| event["method"] == "business_dispatch").unwrap()
        ["operationId"]
        .clone();
    assert_eq!(bindings.len(), 3);
    for binding in bindings {
        assert_eq!(binding["stopRevision"], 1);
        assert_eq!(binding["debugId"], original_agent);
        assert_eq!(binding["frame"], 2);
    }
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn old_frame_reads_and_old_stop_mutations_never_become_current() {
    let fixture = Fixture::new("read_delay").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    let state = fixture.state.clone();
    let read_access = access.clone();
    let read_reference = reference.clone();
    let reading = tokio::spawn(async move {
        pl_debug_read_core(
            &state,
            &read_access,
            PlDebugRead {
                session: read_reference,
                generation: 1,
                stop_revision: Some(1),
                kind: PlDebugReadKind::Variables,
                params: json!({"frame":0}),
            },
        )
        .await
    });
    fixture.wait_event("read_entered").await;
    let step = fixture.operation(&access, &reference, "step", PlDebugAction::StepOver).await;
    pl_debug_operate_core(&fixture.state, &access, step).await.unwrap();
    fixture.receipt(&access, &reference, "step").await;
    fixture.release("read-gate");
    assert!(reading.await.unwrap().is_err());
    let mut assignment = fixture.operation(&access, &reference, "old-value", PlDebugAction::SetValue).await;
    assignment.params = json!({"name":"N","value":"9","frame":0,"stopRevision":1});
    assert!(pl_debug_operate_core(&fixture.state, &access, assignment).await.is_err());
    assert_eq!(fixture.count("pl_debug_set_value"), 0);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn restart_lease_restarts_released_idle_workspaces_without_expiring_the_new_generation() {
    for (db_type, driver_type) in
        [(DatabaseType::Oracle, "oracle"), (DatabaseType::OceanbaseOracle, "oceanbase-oracle")]
    {
        let fixture = Fixture::new_for_driver("native", db_type, driver_type).await;
        let access = PlDebugAccess::desktop();
        let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("idle-start")).unwrap();
        let reference = fixture.reference(&start);
        assert!(matches!(fixture.receipt(&access, &reference, "idle-start").await.state, OperationState::Succeeded));
        fixture.close(&access, &reference).await;
        let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
        {
            let mut data = entry.lock();
            assert!(data.runtime_exited && data.close.as_ref().unwrap().done);
            assert_eq!(data.snapshot["releaseState"], "released");
            data.last_heartbeat = Instant::now() - PL_DEBUG_LEASE * 2;
        }
        std::fs::write(
            fixture.state.agent_manager.driver_dir(driver_type).join("mode"),
            "registered_inspect_handshake_hold",
        )
        .unwrap();
        let restart = fixture.operation(&access, &reference, "idle-restart", PlDebugAction::Restart).await;
        let accepted = pl_debug_operate_core(&fixture.state, &access, restart.clone()).await.unwrap();
        assert_eq!(accepted.generation, 2);
        fixture.wait_event("handshake_wait").await;
        fixture.release("handshake-gate");
        let receipt = fixture.receipt(&access, &reference, "idle-restart").await;
        let close_reason = entry.lock().close.as_ref().map(|close| close.reason);
        assert!(
            matches!(receipt.state, OperationState::Succeeded),
            "driver={driver_type};closeReason={close_reason:?};receipt={}",
            serde_json::to_string(&receipt).unwrap()
        );
        assert!(close_reason.is_none());
        let heartbeat = entry.lock().last_heartbeat;
        assert!(matches!(
            pl_debug_operate_core(&fixture.state, &access, restart.clone()).await.unwrap().state,
            OperationState::Succeeded
        ));
        assert_eq!(entry.lock().last_heartbeat, heartbeat, "an original operation replay must not renew the lease");
        let mut changed = restart;
        changed.params = json!({"target":{"source":"BEGIN NULL; END;","schema":"OTHER"}});
        assert!(pl_debug_operate_core(&fixture.state, &access, changed).await.is_err());
        let dispatches =
            fixture.events().into_iter().filter(|event| event["method"] == "business_dispatch").collect::<Vec<_>>();
        assert_eq!(dispatches.len(), 2);
        assert_ne!(dispatches[0]["scope"], dispatches[1]["scope"]);
        let close = fixture.operation(&access, &reference, "close-idle-restarted", PlDebugAction::Close).await;
        pl_debug_operate_core(&fixture.state, &access, close).await.unwrap();
        assert!(matches!(
            fixture.receipt(&access, &reference, "close-idle-restarted").await.state,
            OperationState::Succeeded
        ));
        assert!(entry.lock().runtime_exited);
        assert_eq!(entry.lock().snapshot["releaseState"], "released");
    }
}

#[tokio::test]
async fn restart_lease_only_expires_the_current_unrenewed_generation_once() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("lease-start")).unwrap();
    let reference = fixture.reference(&start);
    assert!(matches!(fixture.receipt(&access, &reference, "lease-start").await.state, OperationState::Succeeded));
    fixture.close(&access, &reference).await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    assert!(!lifecycle::request_lease_close(&entry, 1), "an exited runtime cannot acquire a lease close");
    std::fs::write(fixture.state.agent_manager.driver_dir("oracle").join("mode"), "close_delay").unwrap();
    let restart = fixture.operation(&access, &reference, "lease-restart", PlDebugAction::Restart).await;
    pl_debug_operate_core(&fixture.state, &access, restart).await.unwrap();
    assert!(matches!(fixture.receipt(&access, &reference, "lease-restart").await.state, OperationState::Succeeded));
    entry.lock().last_heartbeat = Instant::now() - PL_DEBUG_LEASE * 2;
    let revision = entry.lock().revision;
    assert!(!lifecycle::request_lease_close(&entry, 1), "an expired old generation cannot close its replacement");
    assert_eq!(entry.lock().revision, revision);
    assert!(entry.lock().close.is_none());
    pl_debug_heartbeat_core(&fixture.state, &access, &reference).await.unwrap();
    let revision = entry.lock().revision;
    assert!(!lifecycle::request_lease_close(&entry, 2), "a newer heartbeat must win over an old deadline");
    assert_eq!(entry.lock().revision, revision);
    assert!(entry.lock().close.is_none());
    entry.lock().last_heartbeat = Instant::now() - PL_DEBUG_LEASE * 2;
    entry.changed.notify_waiters();
    tokio::time::timeout(Duration::from_secs(10), async {
        while fixture.count("pl_debug_close") < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let deadline = {
        let data = entry.lock();
        let close = data.close.as_ref().unwrap();
        assert_eq!(close.reason, "lease_expired");
        assert!(!close.done);
        close.deadline
    };
    assert!(!lifecycle::request_lease_close(&entry, 2), "an existing close keeps its original owner and deadline");
    pl_debug_heartbeat_core(&fixture.state, &access, &reference).await.unwrap();
    assert_eq!(entry.lock().close.as_ref().unwrap().deadline, deadline);
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !entry.lock().close.as_ref().unwrap().done {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(entry.lock().runtime_exited);
    assert_eq!(entry.lock().snapshot["releaseState"], "released");
    assert!(!lifecycle::request_lease_close(&entry, 2));
    assert_eq!(fixture.count("pl_debug_close"), 2);
    assert_eq!(fixture.count("business_dispatch"), 2);
    assert!(matches!(
        pl_debug_operation_core(&fixture.state, &access, &reference, "lease-start").unwrap().state,
        OperationState::Succeeded
    ));
}

#[tokio::test]
async fn close_retains_output_and_restart_gets_a_new_generation_and_runtime_scope() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    fixture.close(&access, &reference).await;
    let output = pl_debug_read_core(
        &fixture.state,
        &access,
        PlDebugRead {
            session: reference.clone(),
            generation: 1,
            stop_revision: None,
            kind: PlDebugReadKind::Log,
            params: json!({}),
        },
    )
    .await
    .unwrap();
    assert_eq!(output["output"], "one\n\n中😀*|\\\n");
    assert_eq!(fixture.count("pl_debug_close"), 1);
    let restart = fixture.operation(&access, &reference, "restart", PlDebugAction::Restart).await;
    let result = pl_debug_operate_core(&fixture.state, &access, restart).await.unwrap();
    assert_eq!(result.generation, 2);
    fixture.receipt(&access, &reference, "restart").await;
    let dispatches =
        fixture.events().into_iter().filter(|event| event["method"] == "business_dispatch").collect::<Vec<_>>();
    assert_eq!(dispatches.len(), 2);
    assert_ne!(dispatches[0]["scope"], dispatches[1]["scope"]);
    let mut close = fixture.operation(&access, &reference, "close-restarted", PlDebugAction::Close).await;
    close.params = json!({});
    pl_debug_operate_core(&fixture.state, &access, close).await.unwrap();
    fixture.receipt(&access, &reference, "close-restarted").await;
}

#[tokio::test]
async fn repeated_close_shares_one_owner_and_a_shorter_deadline_only_isolates_the_original() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    request_close(&entry, "client_close", Instant::now() + Duration::from_secs(60));
    fixture.wait_event("close_entered").await;
    request_close(&entry, "application_shutdown", Instant::now() + Duration::from_millis(100));
    request_close(&entry, "lease_expired", Instant::now() + Duration::from_secs(60));
    tokio::time::timeout(Duration::from_secs(3), async {
        while !entry.lock().close.as_ref().unwrap().done {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.count("pl_debug_close"), 1);
    let status = pl_debug_status_core(&fixture.state, &access, &reference, true).await.unwrap();
    assert_eq!(status["releaseState"], "unknown");
    assert_eq!(status["executionOutcome"], "unknown");
    assert!(status.get("controllerLossRisk").is_some());
    let restart = fixture.operation(&access, &reference, "unsafe-restart", PlDebugAction::Restart).await;
    assert!(pl_debug_operate_core(&fixture.state, &access, restart).await.is_err());
    assert_eq!(fixture.count("business_dispatch"), 1);
}

#[test]
fn retained_output_uses_the_agents_utf16_cursor_without_splitting_surrogates() {
    let output = json!({"output":"A😀中B","outputComplete":true,"outputTruncated":false,"outputError":null});
    let first = retained_log_page(&output, &json!({"offset":0,"limit":2})).unwrap();
    assert_eq!(first["outputPage"]["text"], "A");
    assert_eq!(first["outputPage"]["nextOffset"], 1);
    let second = retained_log_page(&output, &json!({"offset":1,"limit":2})).unwrap();
    assert_eq!(second["outputPage"]["text"], "😀");
    assert_eq!(second["outputPage"]["nextOffset"], 3);
    assert!(retained_log_page(&output, &json!({"offset":2,"limit":2})).is_err());
    assert!(retained_log_page(&output, &json!({"offset":-1,"limit":2})).is_err());
}

#[tokio::test]
async fn heartbeat_renews_the_original_agent_lease() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    pl_debug_heartbeat_core(&fixture.state, &access, &reference).await.unwrap();
    assert_eq!(fixture.count("pl_debug_heartbeat"), 1);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn missing_stop_revision_cannot_authorize_reads_or_assignments() {
    let fixture = Fixture::new("missing_stop").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    let read = PlDebugRead {
        session: reference.clone(),
        generation: 1,
        stop_revision: None,
        kind: PlDebugReadKind::Variables,
        params: json!({}),
    };
    assert!(pl_debug_read_core(&fixture.state, &access, read).await.is_err());
    let mut assignment = fixture.operation(&access, &reference, "missing-stop-value", PlDebugAction::SetValue).await;
    assignment.params = json!({"name":"N","value":"9","frame":0});
    assert!(pl_debug_operate_core(&fixture.state, &access, assignment).await.is_err());
    assert_eq!(fixture.count("pl_debug_get_variables"), 0);
    assert_eq!(fixture.count("pl_debug_set_value"), 0);
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn revoked_owner_cancels_pending_writes_and_keeps_the_original_record() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::web("browser".into()).unwrap();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    let mut request = fixture.operation(&access, &reference, "pending-write", PlDebugAction::SetValue).await;
    request.params = json!({"name":"N","value":"9","stopRevision":1});
    let configs = fixture.state.configs.write().await;
    let mut pending = Box::pin(pl_debug_operate_core(&fixture.state, &access, request));
    assert!(futures::poll!(&mut pending).is_pending());
    pl_debug_revoke_web_owner_core(&fixture.state, "browser");
    pl_debug_revoke_web_owner_core(&fixture.state, "browser");
    drop(configs);
    assert!(pending.await.is_err());
    assert!(pl_debug_status_core(&fixture.state, &access, &reference, false).await.is_err());
    assert!(pl_debug_list_core(&fixture.state, &access, reference.server_epoch, "conn").unwrap().is_empty());
    fixture.wait_event("process_exit").await;
    assert_eq!(fixture.count("pl_debug_set_value"), 0);
    assert_eq!(fixture.count("pl_debug_close"), 1);
    assert_eq!(fixture.count("business_dispatch"), 1);
    assert!(fixture.state.pl_debug.lock().sessions.contains_key(&reference.session_id));
    tokio::time::timeout(Duration::from_secs(3), async {
        while !entry.lock().runtime_exited {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(entry.lock().snapshot["releaseState"], "released");
}

#[tokio::test]
async fn revoked_owner_stops_a_queued_start_before_allocating_an_agent() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::web("browser".into()).unwrap();
    let configs = fixture.state.configs.write().await;
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    pl_debug_revoke_web_owner_core(&fixture.state, "browser");
    drop(configs);
    tokio::time::timeout(Duration::from_secs(3), async {
        while !entry.lock().runtime_exited {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(entry.lock().snapshot["executionOutcome"], "not_started");
    assert_eq!(fixture.count("open_session"), 0);
    assert_eq!(fixture.count("business_dispatch"), 0);
}

#[tokio::test]
async fn idle_sweep_preserves_a_paused_debugger_and_its_query_pool_until_release() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    fixture.idle_query_pool().await;
    let mut events = fixture.state.subscribe_connection_idle_closed();
    pl_debug_heartbeat_core(&fixture.state, &access, &reference).await.unwrap();
    assert!(fixture.state.sweep_idle_connections().await.is_empty());
    assert!(fixture.state.pool_handle("conn").await.is_some());
    assert!(events.try_recv().is_err());
    assert_eq!(fixture.count("pl_debug_close"), 0);
    fixture.close(&access, &reference).await;
    assert_eq!(fixture.state.sweep_idle_connections().await, vec!["conn"]);
    assert_eq!(events.try_recv().unwrap().connection_id, "conn");
}

#[tokio::test]
async fn idle_sweep_does_not_race_the_original_expired_lease_cleanup() {
    let fixture = Fixture::new("close_delay").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    fixture.idle_query_pool().await;
    let mut events = fixture.state.subscribe_connection_idle_closed();
    let entry = fixture.state.pl_debug.find(&access, &reference).unwrap();
    entry.lock().last_heartbeat = Instant::now() - PL_DEBUG_LEASE * 2;
    entry.changed.notify_waiters();
    fixture.wait_event("close_entered").await;
    assert!(fixture.state.sweep_idle_connections().await.is_empty());
    assert!(fixture.state.pool_handle("conn").await.is_some());
    assert!(events.try_recv().is_err());
    assert_eq!(fixture.count("pl_debug_close"), 1);
    fixture.release("close-gate");
    tokio::time::timeout(Duration::from_secs(3), async {
        while !entry.lock().runtime_exited {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(entry.lock().snapshot["releaseState"], "released");
    assert_eq!(fixture.state.sweep_idle_connections().await, vec!["conn"]);
    assert_eq!(events.try_recv().unwrap().connection_id, "conn");
}

#[tokio::test]
async fn idle_fence_blocks_new_starts_until_the_drain_and_event_window_ends() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let fence = fixture.state.pl_debug.try_idle_fence("conn").unwrap();
    assert!(fixture.state.pl_debug.try_idle_fence("conn").is_none());
    let request = fixture.start_request("start");
    assert!(pl_debug_start_core(&fixture.state, &access, request.clone()).is_err());
    assert_eq!(fixture.count("open_session"), 0);
    drop(fence);
    let start = pl_debug_start_core(&fixture.state, &access, request).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    fixture.close(&access, &reference).await;
}

#[tokio::test]
async fn idle_fence_also_blocks_restart_without_consuming_its_operation_identity() {
    let fixture = Fixture::new("native").await;
    let access = PlDebugAccess::desktop();
    let start = pl_debug_start_core(&fixture.state, &access, fixture.start_request("start")).unwrap();
    let reference = fixture.reference(&start);
    fixture.receipt(&access, &reference, "start").await;
    fixture.close(&access, &reference).await;
    let restart = fixture.operation(&access, &reference, "restart", PlDebugAction::Restart).await;
    let fence = fixture.state.pl_debug.try_idle_fence("conn").unwrap();
    assert!(pl_debug_operate_core(&fixture.state, &access, restart.clone()).await.is_err());
    assert_eq!(fixture.count("business_dispatch"), 1);
    drop(fence);
    let accepted = pl_debug_operate_core(&fixture.state, &access, restart).await.unwrap();
    assert_eq!(accepted.generation, 2);
    fixture.receipt(&access, &reference, "restart").await;
    let close = fixture.operation(&access, &reference, "close-restarted", PlDebugAction::Close).await;
    pl_debug_operate_core(&fixture.state, &access, close).await.unwrap();
    fixture.receipt(&access, &reference, "close-restarted").await;
}
