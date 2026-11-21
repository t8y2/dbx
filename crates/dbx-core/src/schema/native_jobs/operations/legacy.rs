use super::*;

pub(super) fn receipt(id: &str, phase: NativeJobLegacyPhase, reason: &'static str) -> NativeJobLegacyReceipt {
    NativeJobLegacyReceipt {
        operation_id: id.into(),
        phase,
        job_id: None,
        reason: Some(reason.into()),
        vendor_code: None,
        disposal_confirmed: None,
    }
}

fn safe_reason(reason: &Option<String>) -> Option<String> {
    reason.as_ref().map(|reason| {
        if reason.len() <= 96
            && reason.starts_with("native_job_")
            && reason.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            reason.clone()
        } else {
            "native_job_legacy_protocol_error".into()
        }
    })
}

fn mark(state: &AppState, id: &str, index: usize, phase: NativeJobStepState, native: &NativeJobLegacyReceipt) {
    state.native_jobs.operations().edit(id, |status| {
        status.steps[index].state = phase;
        status.steps[index].reason = safe_reason(&native.reason);
        status.steps[index].vendor_code = native.vendor_code;
    });
}

async fn rollback_before_commit(
    state: &AppState,
    id: &str,
    job_id: Option<&str>,
    session: &mut impl NativeJobMutationSession,
    reason: &'static str,
) -> Result<NativeJobOperationOutcome, (&'static str, NativeJobOperationOutcome)> {
    let native = session.finish_legacy(id, job_id, false).await;
    let confirmed = native.operation_id == id
        && native.phase == NativeJobLegacyPhase::RolledBack
        && native.job_id.as_deref().is_none_or(|actual| job_id.is_none_or(|expected| actual == expected));
    mark(state, id, 0, if confirmed { NativeJobStepState::Failed } else { NativeJobStepState::Unknown }, &native);
    Err(if confirmed {
        (reason, NativeJobOperationOutcome::NotApplied)
    } else {
        ("native_job_rollback_unknown", NativeJobOperationOutcome::Unknown)
    })
}

pub(super) async fn run_create(
    state: &AppState,
    execution: &PreparedExecution,
    id: &str,
    cancel: &CancellationToken,
    session: &mut impl NativeJobMutationSession,
    created_guard: &mut Option<tokio::sync::OwnedMutexGuard<()>>,
    dispatched: &mut bool,
) -> Result<NativeJobOperationOutcome, (&'static str, NativeJobOperationOutcome)> {
    let PreparedAction::LegacyCreate { definition, .. } = &execution.action else { unreachable!() };
    let operations = state.native_jobs.operations();
    if cancel.is_cancelled() {
        return Err(("native_job_canceled_before_dispatch", NativeJobOperationOutcome::NotApplied));
    }
    operations.edit(id, |status| {
        status.state = NativeJobOperationState::Running;
        status.steps[0].state = NativeJobStepState::Dispatching;
    });
    *dispatched = true;
    // Await the receipt even when the page cancels: only the owner can dispose this transaction.
    let prepared = session.prepare_legacy(id, definition).await;
    let target = prepared.job_id.as_ref().and_then(|job_id| {
        let target = NativeJobRef::Legacy { scope: execution.binding.context.scope.clone(), job_id: job_id.clone() };
        target.validate().ok().map(|_| target)
    });
    if prepared.operation_id != id {
        return rollback_before_commit(state, id, None, session, "native_job_legacy_protocol_error").await;
    }
    if prepared.phase != NativeJobLegacyPhase::NotStarted {
        if let Some(target) = &target {
            // Persist the real OUT identity before authorizing the first COMMIT.
            operations.edit(id, |status| status.target = Some(target.clone()));
        }
    }
    if matches!(prepared.phase, NativeJobLegacyPhase::NotStarted | NativeJobLegacyPhase::RolledBack) {
        mark(state, id, 0, NativeJobStepState::Failed, &prepared);
        let reason = if prepared.reason.as_deref() == Some("native_job_legacy_runtime_update_required") {
            "native_job_legacy_runtime_update_required"
        } else {
            "native_job_legacy_not_applied"
        };
        return Err((reason, NativeJobOperationOutcome::NotApplied));
    }
    let Some(NativeJobRef::Legacy { job_id, .. }) = target.as_ref() else {
        return rollback_before_commit(state, id, None, session, "native_job_out_id_unverified").await;
    };
    if prepared.phase != NativeJobLegacyPhase::Prepared {
        return rollback_before_commit(state, id, Some(job_id), session, "native_job_prepare_unknown").await;
    }
    mark(state, id, 0, NativeJobStepState::Applied, &prepared);
    let target = target.as_ref().expect("validated OUT target");
    let identity = NativeJobRow::from([("DBX_JOB_ID".into(), Value::String(job_id.clone()))]);
    let lock = operations.job_lock(&native_origin_key(&execution.binding, target, &identity));
    *created_guard = Some(tokio::select! {
        biased;
        _ = cancel.cancelled() => return rollback_before_commit(state, id, Some(job_id), session, "native_job_canceled_before_commit").await,
        _ = execution.binding.lifecycle.cancellation().cancelled() => return rollback_before_commit(state, id, Some(job_id), session, "native_job_context_changed").await,
        guard = lock.lock_owned() => guard,
    });
    let stopped = if cancel.is_cancelled() {
        Some("native_job_canceled_before_commit")
    } else {
        require_write(state, &execution.binding).await.err()
    };
    if let Some(reason) = stopped {
        return rollback_before_commit(state, id, Some(job_id), session, reason).await;
    }
    operations.edit(id, |status| status.steps[1].state = NativeJobStepState::Dispatching);
    let commit = session.finish_legacy(id, Some(job_id), true).await;
    // No SUBMIT, COMMIT, BROKEN, or ROLLBACK is resent after this call.
    let matching = commit.operation_id == id && commit.job_id.as_deref().is_none_or(|actual| actual == job_id);
    if matching && commit.phase == NativeJobLegacyPhase::RolledBack {
        mark(state, id, 1, NativeJobStepState::Failed, &commit);
        return Err(("native_job_legacy_not_applied", NativeJobOperationOutcome::NotApplied));
    }
    let committed =
        matching && commit.phase == NativeJobLegacyPhase::Committed && commit.job_id.as_deref() == Some(job_id);
    mark(state, id, 1, if committed { NativeJobStepState::Applied } else { NativeJobStepState::Unknown }, &commit);
    if !matching
        || !matches!(
            commit.phase,
            NativeJobLegacyPhase::Committed | NativeJobLegacyPhase::CommitSent | NativeJobLegacyPhase::Unknown
        )
    {
        return Err(("native_job_legacy_commit_unknown", NativeJobOperationOutcome::Unknown));
    }
    if !state.connection_lifecycle_is_current(&target.scope().connection_id, &execution.binding.lifecycle) {
        return Err((
            "native_job_context_changed",
            if committed { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Unknown },
        ));
    }
    operations.edit(id, |status| status.steps[2].state = NativeJobStepState::Dispatching);
    let after = session.read(target).await;
    let verified = after.as_ref().is_ok_and(|details| {
        verify_created(
            details,
            target,
            definition,
            &execution.binding.context.session_user,
            execution.binding.context.engine,
        )
    });
    if !verified {
        operations.edit(id, |status| {
            status.steps[2].state = NativeJobStepState::Unknown;
            status.steps[2].reason = Some("native_job_readback_not_verified".into());
        });
        return Err((
            "native_job_readback_not_verified",
            if committed { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Unknown },
        ));
    }
    operations.edit(id, |status| {
        status.steps[1].state = NativeJobStepState::Applied;
        status.steps[2].state = NativeJobStepState::Applied;
    });
    Ok(NativeJobOperationOutcome::Verified)
}

pub(super) fn same_date(actual: Option<&Value>, expected: &str) -> bool {
    let Some(actual) = actual.and_then(Value::as_str) else { return false };
    let parsed = ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"]
        .into_iter()
        .find_map(|format| chrono::NaiveDateTime::parse_from_str(actual, format).ok());
    parsed
        .is_some_and(|parsed| chrono::NaiveDateTime::parse_from_str(expected, "%Y-%m-%d %H:%M:%S").ok() == Some(parsed))
}

fn verify_created(
    details: &NativeJobDetails,
    target: &NativeJobRef,
    expected: &NativeJobLegacyCreate,
    user: &str,
    engine: NativeJobEngine,
) -> bool {
    if &details.snapshot.job_ref != target || !matches!(details.consistency, NativeJobMetadata::Available { .. }) {
        return false;
    }
    let NativeJobRef::Legacy { job_id, .. } = target else { return false };
    let NativeJobMetadata::Available { value: identity } = &details.native_identity else { return false };
    if identity.get("DBX_JOB_ID").and_then(Value::as_str) != Some(job_id) {
        return false;
    }
    let Some(row) = row(details) else { return false };
    let instance = row.get("INSTANCE").and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()));
    let placement_matches = if engine == NativeJobEngine::OceanbaseOracle {
        row.get("INSTANCE").is_some_and(|actual| match &expected.zone {
            Some(zone) => actual.as_str() == Some(zone),
            None => actual.is_null(),
        })
    } else {
        instance == Some(expected.instance)
    };
    row.get("WHAT").and_then(Value::as_str) == Some(expected.what.as_str())
        && row.get("INTERVAL").and_then(Value::as_str).unwrap_or("") == expected.interval
        && row.get("BROKEN").and_then(Value::as_str) == Some(if expected.enabled { "N" } else { "Y" })
        && placement_matches
        && row.get("LOG_USER").and_then(Value::as_str) == Some(user)
        && row.get("PRIV_USER").and_then(Value::as_str) == Some(user)
        && row.get("SCHEMA_USER").and_then(Value::as_str) == Some(expected.schema.as_str())
        // Initial NEXT_DATE was checked on the uncommitted connection. Enabled jobs may advance it.
        && (expected.enabled || same_date(row.get("NEXT_DATE"), &expected.next_date))
}
