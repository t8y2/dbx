use super::*;

pub(crate) async fn drain_connection<'a>(
    state: &'a AppState,
    connection_id: &str,
    reason: &'static str,
) -> Result<PlDebugConnectionFence<'a>, String> {
    drain_connection_inner(state, connection_id, reason, None, None)
        .await?
        .ok_or_else(|| "The original connection cleanup was superseded".into())
}

pub(crate) async fn drain_transport<'a>(
    state: &'a AppState,
    connection_id: &str,
    expected: Option<&ConnectionTransportStamp>,
    protect_debuggers: bool,
    deadline: Option<Instant>,
) -> Result<Option<PlDebugConnectionFence<'a>>, String> {
    drain_connection_inner(state, connection_id, "transport_reset", Some((expected, protect_debuggers)), deadline).await
}

async fn drain_connection_inner<'a>(
    state: &'a AppState,
    connection_id: &str,
    reason: &'static str,
    transport: Option<(Option<&ConnectionTransportStamp>, bool)>,
    deadline: Option<Instant>,
) -> Result<Option<PlDebugConnectionFence<'a>>, String> {
    let (drain, gate) = {
        let mut registry = state.pl_debug.lock();
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err("The original connection cleanup deadline expired".into());
        }
        if let Some((expected, protect_debuggers)) = transport {
            let current = registry.transports.get(connection_id);
            let matches = match (current, expected) {
                (Some(current), Some(expected)) => current.stamp.same_token(expected),
                (None, None) => true,
                _ => false,
            };
            if !matches
                || (protect_debuggers
                    && registry.connection_drains.contains_key(connection_id)
                    && mutation::held_connection_fence(&state.pl_debug, &registry, connection_id).is_none())
            {
                return Ok(None);
            }
            if protect_debuggers {
                let mut protected = false;
                let cleanup_owner = registry.sessions.values().find_map(|entry| {
                    if entry.start.connection_id != connection_id {
                        return None;
                    }
                    let data = entry.lock();
                    if !data.protects_execution() {
                        return None;
                    }
                    protected = true;
                    data.transport_stamp
                        .as_ref()
                        .filter(|original| expected.is_some_and(|expected| original.same_runtime(expected)))
                        .cloned()
                });
                if protected {
                    if let Some(original) = cleanup_owner {
                        registry.transports.get_mut(connection_id).unwrap().stamp = original;
                    }
                    return Ok(None);
                }
                let inspection_stamp = registry.inspections.values().find_map(|inspection| {
                    (inspection.request.connection_id == connection_id).then(|| inspection.active_transport()).flatten()
                });
                if let Some(original) = inspection_stamp {
                    if expected.is_some_and(|expected| original.same_runtime(expected)) {
                        registry.transports.get_mut(connection_id).unwrap().stamp = original;
                    }
                    return Ok(None);
                }
            }
        }
        mutation::authorize_connection_cleanup(&state.pl_debug, &registry, connection_id)?;
        if let Some(token) = mutation::held_connection_fence(&state.pl_debug, &registry, connection_id) {
            let drain = registry
                .connection_drains
                .get_mut(connection_id)
                .filter(|drain| drain.intent.token == token)
                .ok_or("The original accepted connection cleanup was superseded")?;
            drain.users += 1;
            return Ok(Some(PlDebugConnectionFence {
                registry: &state.pl_debug,
                connection_id: connection_id.to_owned(),
                token,
                release: false,
                _mutation: None,
                drain: Some(ConnectionDrainUse {
                    registry: &state.pl_debug,
                    connection_id: connection_id.to_owned(),
                    intent: drain.intent.clone(),
                    completed: false,
                }),
            }));
        }
        let drain = if let Some(drain) = registry.connection_drains.get_mut(connection_id) {
            drain.users += 1;
            drain.intent.clone()
        } else {
            let drain = Arc::new(ConnectionDrain {
                token: Uuid::new_v4(),
                entries: registry
                    .sessions
                    .values()
                    .filter(|entry| entry.start.connection_id == connection_id && entry.lock().protects_execution())
                    .cloned()
                    .collect(),
                inspections: registry
                    .inspections
                    .values()
                    .filter(|inspection| inspection.request.connection_id == connection_id)
                    .cloned()
                    .collect(),
                deadline: deadline.unwrap_or_else(|| Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT),
                reason,
            });
            registry
                .connection_drains
                .insert(connection_id.to_owned(), ConnectionDrainState { intent: drain.clone(), users: 1 });
            drain
        };
        let gate = registry
            .connection_gates
            .entry(connection_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        (drain, gate)
    };
    let effective_deadline = deadline.map_or(drain.deadline, |deadline| deadline.min(drain.deadline));
    let drain_use = ConnectionDrainUse {
        registry: &state.pl_debug,
        connection_id: connection_id.to_owned(),
        intent: drain.clone(),
        completed: false,
    };
    state.pl_debug.changed.notify_waiters();
    for entry in &drain.entries {
        request_close(entry, drain.reason, effective_deadline);
    }
    for inspection in &drain.inspections {
        inspection.invalidate();
    }
    let mutation = tokio::time::timeout_at(effective_deadline.into(), gate.lock_owned())
        .await
        .map_err(|_| "The original connection cleanup is still in progress".to_owned())?;
    loop {
        let notified = state.pl_debug.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let mut registry = state.pl_debug.lock();
            let token = registry.connection_fences.get(connection_id).copied();
            if token.is_none_or(|token| registry.retained_fences.contains(&token)) {
                if let Some(token) = token {
                    registry.retained_fences.remove(&token);
                }
                registry.connection_fences.insert(connection_id.to_owned(), drain.token);
                registry.retained_fences.insert(drain.token);
                break;
            }
        }
        tokio::time::timeout_at(effective_deadline.into(), notified)
            .await
            .map_err(|_| "The original connection cleanup is still in progress".to_owned())?;
    }
    let fence = PlDebugConnectionFence {
        registry: &state.pl_debug,
        connection_id: connection_id.to_owned(),
        token: drain.token,
        release: false,
        _mutation: Some(mutation),
        drain: Some(drain_use),
    };
    wait_for_entries(&drain.entries, effective_deadline).await?;
    inspection::wait_for_inspections(&drain.inspections, effective_deadline).await?;
    Ok(Some(fence))
}

pub(crate) struct PlDebugShutdown {
    entries: Vec<Arc<Entry>>,
    inspections: Vec<Arc<InspectionOwner>>,
    deadline: Instant,
}

pub(crate) fn begin_shutdown(state: &AppState, deadline: Instant) -> Option<PlDebugShutdown> {
    let (entries, inspections) = {
        let mut registry = state.pl_debug.lock();
        registry.accepting = false;
        (
            registry.sessions.values().filter(|entry| !entry.lock().runtime_exited).cloned().collect::<Vec<_>>(),
            registry.inspections.values().cloned().collect::<Vec<_>>(),
        )
    };
    if entries.is_empty() && inspections.is_empty() {
        return None;
    }
    let deadline = deadline.min(Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT);
    for entry in &entries {
        request_close(entry, "application_shutdown", deadline);
    }
    for inspection in &inspections {
        inspection.invalidate();
    }
    Some(PlDebugShutdown { entries, inspections, deadline })
}

impl PlDebugShutdown {
    pub(crate) async fn wait(&self) -> Result<(), String> {
        wait_for_entries(&self.entries, self.deadline).await?;
        inspection::wait_for_inspections(&self.inspections, self.deadline).await
    }

    pub(crate) fn isolate_remaining(&self) {
        isolate_entries(&self.entries);
        for inspection in &self.inspections {
            inspection.isolate();
        }
    }
}

fn isolate_entries(entries: &[Arc<Entry>]) {
    for original in entries {
        let generation = original.lock().generation;
        force_isolate(original, generation);
    }
}

async fn wait_for_entries(entries: &[Arc<Entry>], deadline: Instant) -> Result<(), String> {
    let deadline = entries.iter().fold(deadline, |deadline, entry| {
        let data = entry.lock();
        if data.runtime_exited {
            deadline
        } else {
            data.close.as_ref().map_or(deadline, |close| deadline.min(close.deadline))
        }
    });
    for entry in entries {
        loop {
            let notified = entry.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (channel, entry_deadline) = {
                let data = entry.lock();
                if data.runtime_exited {
                    break;
                }
                (data.channel.clone(), data.close.as_ref().map_or(deadline, |close| deadline.min(close.deadline)))
            };
            if let Some(channel) = channel {
                if channel.wait_for_exit(Duration::ZERO).await {
                    confirm_exit(entry, &channel).await;
                    if entry.lock().runtime_exited {
                        break;
                    }
                }
            }
            if tokio::time::timeout_at(entry_deadline.into(), notified).await.is_err() {
                isolate_entries(entries);
                return Err("The original debugger process has not confirmed exit; its connection and cleanup identity are retained".into());
            }
        }
    }
    Ok(())
}

pub(super) fn spawn_watchdog(state: &AppState, entry: Arc<Entry>) {
    let generation = entry.lock().generation;
    state.pl_debug_supervisor().spawn_once(
        format!("pl-debug-lease:{}:{generation}", entry.id),
        move |cancel| async move {
            loop {
                let notified = entry.changed.notified();
                let deadline = {
                    let data = entry.lock();
                    if data.generation != generation || data.runtime_exited || data.close.is_some() {
                        return;
                    }
                    data.last_heartbeat + PL_DEBUG_LEASE
                };
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = notified => {},
                    _ = tokio::time::sleep_until(deadline.into()) => {
                        if request_lease_close(&entry, generation) {
                            return;
                        }
                    }
                }
            }
        },
    );
}

pub(super) fn request_close(entry: &Arc<Entry>, reason: &'static str, deadline: Instant) {
    request_close_inner(entry, reason, deadline, None);
}

pub(super) fn request_lease_close(entry: &Arc<Entry>, generation: u64) -> bool {
    request_close_inner(entry, "lease_expired", Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT, Some(generation))
}

fn request_close_inner(
    entry: &Arc<Entry>,
    reason: &'static str,
    deadline: Instant,
    lease_generation: Option<u64>,
) -> bool {
    let (fresh, exited, generation) = {
        let mut data = entry.lock();
        if lease_generation.is_some_and(|generation| {
            data.generation != generation
                || data.runtime_exited
                || data.close.is_some()
                || data.last_heartbeat + PL_DEBUG_LEASE > Instant::now()
        }) {
            return false;
        }
        let fresh = if data.runtime_exited {
            false
        } else if let Some(close) = &mut data.close {
            close.deadline = close.deadline.min(deadline);
            false
        } else {
            data.close = Some(CloseIntent { deadline, done: false, reason });
            data.control_serial += 1;
            data.revision += 1;
            true
        };
        (fresh, data.runtime_exited, data.generation)
    };
    entry.changed.notify_waiters();
    if exited {
        finish_close_receipt(entry, generation);
        return true;
    }
    if !fresh {
        return true;
    }
    let Some(app) = entry.app.upgrade() else {
        force_isolate(entry, generation);
        return true;
    };
    let task_entry = entry.clone();
    if !app.pl_debug_supervisor().spawn_once(format!("pl-debug-close:{}:{generation}", entry.id), move |_| async move {
        let cleanup = cleanup_original(&task_entry, generation);
        tokio::pin!(cleanup);
        loop {
            let notified = task_entry.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let deadline = {
                let data = task_entry.lock();
                if data.generation != generation {
                    return;
                }
                data.close.as_ref().unwrap().deadline
            };
            tokio::select! {
                _ = &mut cleanup => break,
                _ = notified => {},
                _ = tokio::time::sleep_until(deadline.into()) => { force_isolate(&task_entry, generation); break; }
            }
        }
        {
            let mut data = task_entry.lock();
            if data.generation != generation {
                return;
            }
            data.close.as_mut().unwrap().done = true;
            data.revision += 1;
        }
        finish_close_receipt(&task_entry, generation);
        task_entry.changed.notify_waiters();
    }) {
        force_isolate(entry, generation);
        finish_close_receipt(entry, generation);
    }
    true
}

pub(super) fn force_isolate(entry: &Arc<Entry>, generation: u64) {
    let mut data = entry.lock();
    if data.generation != generation || data.runtime_exited {
        return;
    }
    if let Some(channel) = &data.channel {
        channel.fail_stop();
    }
    if data.snapshot["executionStopped"] != true {
        data.snapshot["state"] = json!("unknown");
        data.snapshot["executionOutcome"] = json!("unknown");
        data.snapshot["controllerLossRisk"] = json!(
            "The database program may continue after controller loss; local process isolation does not prove termination or rollback"
        );
    }
    if data.snapshot["releaseState"] != "released" {
        data.snapshot["releaseState"] = json!("unknown");
    }
    data.snapshot["cleanupOutcome"] = json!("isolated_unconfirmed");
    data.snapshot["cleanupReason"] = json!(data.close.as_ref().map(|close| close.reason));
    if data.snapshot["resultRetentionState"] == "pending" {
        data.snapshot["resultRetentionState"] = data
            .retained_results
            .manifests(generation)
            .map_or(json!("unavailable"), |value| value["retentionState"].clone());
        data.snapshot["resultRetentionError"] =
            json!("The original cleanup deadline ended before result handoff completed");
    }
    if let Some(close) = &mut data.close {
        close.done = true;
    }
    drop(data);
    entry.changed.notify_waiters();
    observe_isolated_exit(entry, generation);
}

fn observe_isolated_exit(entry: &Arc<Entry>, generation: u64) {
    let Some(app) = entry.app.upgrade() else {
        return;
    };
    let original = entry.clone();
    app.pl_debug_supervisor().spawn_once(
        format!("pl-debug-exit:{}:{generation}", entry.id),
        move |cancel| async move {
            loop {
                let notified = original.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let (channel, start_finished) = {
                    let data = original.lock();
                    if data.generation != generation || data.runtime_exited {
                        return;
                    }
                    (data.channel.clone(), data.start_finished)
                };
                if let Some(channel) = channel {
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        exited = channel.wait_for_exit(Duration::from_secs(60)) => {
                            if exited {
                                confirm_exit(&original, &channel).await;
                                cleanup_finished_transport(&original, generation).await;
                                finish_close_receipt(&original, generation);
                                return;
                            }
                        }
                    }
                } else if start_finished {
                    confirm_unopened_exit(&original, generation);
                    cleanup_finished_transport(&original, generation).await;
                    finish_close_receipt(&original, generation);
                    return;
                } else {
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = notified => {},
                    }
                }
                if original.app.strong_count() == 0 {
                    return;
                }
            }
        },
    );
}

async fn cleanup_original(entry: &Arc<Entry>, generation: u64) {
    let channel = loop {
        let notified = entry.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let (channel, start_finished) = {
            let data = entry.lock();
            if data.generation != generation {
                return;
            }
            (data.channel.clone(), data.start_finished)
        };
        if let Some(channel) = channel {
            break channel;
        }
        if start_finished {
            confirm_unopened_exit(entry, generation);
            cleanup_finished_transport(entry, generation).await;
            return;
        }
        notified.await;
    };
    let (agent_id, dispatched) = {
        let data = entry.lock();
        (data.agent_id.clone(), data.start_dispatched)
    };
    if dispatched {
        // Agent close owns abort/output/rollback/physical release. A false reply
        // merely accepts cleanup which its original lifecycle owner will finish.
        let result = channel.call::<Value>("pl_debug_close", json!({"debugId":agent_id}), QUICK_TIMEOUT, None).await;
        if let Err(error) = result {
            entry.lock().snapshot["cleanupError"] = call_failure(error);
        }
        loop {
            if channel.wait_for_exit(Duration::ZERO).await {
                confirm_exit(entry, &channel).await;
                cleanup_finished_transport(entry, generation).await;
                return;
            }
            if let Ok(value) =
                channel.call::<Value>("pl_debug_status", json!({"debugId":agent_id}), QUICK_TIMEOUT, None).await
            {
                let released = value["releaseState"] == "released";
                {
                    let mut data = entry.lock();
                    apply_agent_snapshot(&mut data, &value);
                    data.revision += 1;
                }
                if released {
                    break;
                }
            }
            tokio::select! { _ = entry.changed.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(500)) => {} }
        }
        match channel.call::<Value>("pl_debug_get_log", json!({"debugId":agent_id}), QUICK_TIMEOUT, None).await {
            Ok(log) => entry.lock().retained_log = Some(log),
            Err(error) => {
                entry.lock().snapshot["outputRetentionError"] = call_failure(error);
            }
        }
        super::results::retain_before_exit(entry, generation, &channel, &agent_id).await;
    }
    let _ = channel.request_shutdown(QUICK_TIMEOUT).await;
    // The outer deadline owner can still kill while this exit wait is pending.
    if channel.wait_for_exit(PL_DEBUG_CLEANUP_TIMEOUT).await {
        confirm_exit(entry, &channel).await;
        cleanup_finished_transport(entry, generation).await;
    }
}

async fn cleanup_finished_transport(entry: &Entry, generation: u64) {
    let stamp = {
        let data = entry.lock();
        if data.generation != generation || !data.runtime_exited {
            return;
        }
        data.transport_stamp.clone()
    };
    if let (Some(app), Some(stamp)) = (entry.app.upgrade(), stamp) {
        app.reset_connection_transport_if_current(&entry.start.connection_id, &stamp).await;
    }
}

fn confirm_unopened_exit(entry: &Entry, generation: u64) {
    let mut data = entry.lock();
    if data.generation != generation || data.channel.is_some() || !data.start_finished || data.start_dispatched {
        return;
    }
    data.runtime_exited = true;
    data.retired_at = Some(Instant::now());
    data.snapshot["releaseState"] = json!("released");
    data.snapshot["executionStopped"] = json!(true);
    data.snapshot["executionOutcome"] = json!("not_started");
    data.snapshot["state"] = json!("ended");
    data.revision += 1;
    drop(data);
    entry.changed.notify_waiters();
    if let Some(app) = entry.app.upgrade() {
        app.pl_debug.changed.notify_waiters();
    }
}

pub(super) async fn confirm_exit(entry: &Entry, channel: &PlDebugAgentChannel) {
    {
        let data = entry.lock();
        if data.runtime_exited || !data.channel.as_ref().is_some_and(|current| current.scope() == channel.scope()) {
            return;
        }
    }
    let retired =
        if let Some(app) = entry.app.upgrade() { channel.retire_after_exit(&app.agent_manager).await } else { false };
    if !retired {
        return;
    }
    let mut data = entry.lock();
    if !data.channel.as_ref().is_some_and(|current| current.scope() == channel.scope()) {
        return;
    }
    data.runtime_exited = true;
    data.retired_at = Some(Instant::now());
    if !data.start_dispatched {
        data.snapshot["releaseState"] = json!("released");
        data.snapshot["executionStopped"] = json!(true);
        data.snapshot["executionOutcome"] = json!("not_started");
        data.snapshot["state"] = json!("ended");
    } else if data.snapshot["releaseState"] != "released" {
        data.snapshot["releaseState"] = json!("unknown");
        if data.snapshot["executionStopped"] != true {
            data.snapshot["state"] = json!("unknown");
            data.snapshot["executionOutcome"] = json!("unknown");
        }
    }
    data.revision += 1;
    drop(data);
    entry.changed.notify_waiters();
}

fn finish_close_receipt(entry: &Entry, generation: u64) {
    if let Some(app) = entry.app.upgrade() {
        app.pl_debug.changed.notify_waiters();
    }
    let mut data = entry.lock();
    if data.generation != generation {
        return;
    }
    let Some(id) = data.close_operation.clone() else {
        return;
    };
    let confirmed = data.runtime_exited && data.snapshot["releaseState"] == "released";
    let result = data.snapshot.clone();
    let revision = data.revision;
    if let Some(operation) = data.operations.get_mut(&id) {
        operation.receipt.state = if confirmed { OperationState::Succeeded } else { OperationState::Unknown };
        operation.receipt.dispatched = true;
        operation.receipt.result = Some(result);
        operation.receipt.revision = revision;
    }
}
