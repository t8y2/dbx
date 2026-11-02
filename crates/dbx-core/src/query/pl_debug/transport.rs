use super::*;
use crate::connection::ConnectionEndpoint;

pub(super) struct TransportRecord {
    pub(super) stamp: ConnectionTransportStamp,
    endpoint: Option<ConnectionEndpoint>,
}

impl TransportRecord {
    pub(super) fn confirms_runtime(&self, stamp: &ConnectionTransportStamp) -> bool {
        self.endpoint.is_some() && self.stamp.same_runtime(stamp) && self.stamp.same_plan(&stamp.plan)
    }
}

pub(crate) struct TransportReservation<'a> {
    registry: &'a PlDebugRegistry,
    connection_id: String,
    pub(crate) stamp: ConnectionTransportStamp,
    pub(crate) replace: bool,
    pub(crate) endpoint: Option<ConnectionEndpoint>,
    _gate: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl TransportReservation<'_> {
    pub(crate) fn finish(
        &self,
        endpoint: &ConnectionEndpoint,
        claimant: Option<&PlDebugPreparation>,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock();
        let record = registry.transports.get_mut(&self.connection_id).ok_or("The original transport was retired")?;
        if !record.stamp.same_token(&self.stamp) {
            return Err("The original transport was replaced".into());
        }
        record.endpoint = Some(endpoint.clone());
        if let Some(claimant) = claimant {
            let mut data = claimant.entry.lock();
            if data.generation != claimant.generation || data.close.is_some() || data.access_revoked {
                return Err("The original debug start was stopped before transport preparation completed".into());
            }
            data.transport_stamp = Some(self.stamp.clone());
        }
        Ok(())
    }
}

pub(crate) fn current_transport(state: &AppState, connection_id: &str) -> Option<ConnectionTransportStamp> {
    state.pl_debug.lock().transports.get(connection_id).map(|record| record.stamp.clone())
}

pub(crate) async fn transport_publication_guard(
    state: &AppState,
    connection_id: &str,
    stamp: &ConnectionTransportStamp,
) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, String> {
    let (gate, held) = {
        let mut registry = state.pl_debug.lock();
        let held = mutation::held_connection_fence(&state.pl_debug, &registry, connection_id).is_some();
        let gate = registry
            .connection_gates
            .entry(connection_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        (gate, held)
    };
    let guard = if held {
        None
    } else {
        Some(
            tokio::time::timeout(PL_DEBUG_CLEANUP_TIMEOUT, gate.lock_owned())
                .await
                .map_err(|_| "The original transport operation is still in progress".to_owned())?,
        )
    };
    let registry = state.pl_debug.lock();
    let held = mutation::held_connection_fence(&state.pl_debug, &registry, connection_id).is_some();
    if (!held
        && (registry.connection_drains.contains_key(connection_id)
            || registry.connection_fences.contains_key(connection_id)))
        || !registry
            .transports
            .get(connection_id)
            .is_some_and(|record| record.endpoint.is_some() && record.stamp.same_runtime(stamp))
    {
        return Err("The original connection transport was superseded before pool publication".into());
    }
    Ok(guard)
}

pub(crate) fn adopt_published_transport(state: &AppState, connection_id: &str, stamp: &ConnectionTransportStamp) {
    let mut registry = state.pl_debug.lock();
    if let Some(record) = registry.transports.get_mut(connection_id) {
        if record.stamp.same_runtime(stamp) {
            record.stamp = stamp.clone();
        }
    }
}

impl PlDebugPreparation {
    pub(crate) fn validate_transport(&self, state: &AppState) -> Result<(), String> {
        let registry = state.pl_debug.lock();
        let data = self.entry.lock();
        if data.generation != self.generation
            || data.close.is_some()
            || data.access_revoked
            || registry.connection_drains.contains_key(&self.entry.start.connection_id)
            || !data.transport_stamp.as_ref().is_some_and(|stamp| {
                registry
                    .transports
                    .get(&self.entry.start.connection_id)
                    .is_some_and(|current| current.endpoint.is_some() && current.stamp.same_plan(&stamp.plan))
            })
        {
            return Err("The original debug transport changed before dispatch".into());
        }
        Ok(())
    }
}

pub(crate) fn retire_transport(state: &AppState, connection_id: &str, expected: Option<&ConnectionTransportStamp>) {
    let mut registry = state.pl_debug.lock();
    if registry
        .transports
        .get(connection_id)
        .is_some_and(|record| expected.is_some_and(|stamp| record.stamp.same_token(stamp)))
    {
        registry.transports.remove(connection_id);
    }
}

fn compatible_entries(
    registry: &RegistryState,
    connection_id: &str,
    plan: &ConnectionTransportPlan,
    claimant: Option<&PlDebugPreparation>,
) -> Result<bool, String> {
    let mut pending = false;
    for entry in registry.sessions.values().filter(|entry| entry.start.connection_id == connection_id) {
        if claimant.is_some_and(|claimant| Arc::ptr_eq(&claimant.entry, entry)) {
            continue;
        }
        let data = entry.lock();
        if !data.protects_execution() {
            continue;
        }
        match &data.transport_plan {
            Some(original) if original == plan => {}
            None if !data.start_finished && data.close.is_none() => pending = true,
            _ => return Err(
                "The protected debug transport differs; use an explicit connection change after closing the debugger"
                    .into(),
            ),
        }
    }
    for inspection in
        registry.inspections.values().filter(|inspection| inspection.request.connection_id == connection_id)
    {
        if inspection.active_transport().is_some_and(|stamp| !stamp.same_plan(plan)) {
            return Err(
                "The protected inspection transport differs; wait for its cleanup before changing the connection"
                    .into(),
            );
        }
    }
    Ok(pending)
}

pub(crate) async fn reserve_transport<'a>(
    state: &'a AppState,
    connection_id: &str,
    plan: &ConnectionTransportPlan,
    claimant: Option<&PlDebugPreparation>,
) -> Result<TransportReservation<'a>, String> {
    if let Some(claimant) = claimant {
        let registry = state.pl_debug.lock();
        let mut data = claimant.entry.lock();
        if data.generation != claimant.generation
            || data.close.is_some()
            || data.access_revoked
            || registry.connection_drains.contains_key(connection_id)
            || registry.connection_fences.contains_key(connection_id)
        {
            return Err("The original debug connection is being cleaned up".into());
        }
        if data.source_profile_ids.as_ref() != Some(&plan.source_profile_ids) {
            return Err("The original debug transport sources changed before preparation".into());
        }
        data.transport_plan = Some(plan.clone());
        drop(data);
        drop(registry);
        state.pl_debug.changed.notify_waiters();
    }
    let deadline = tokio::time::Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT;
    loop {
        let notified = state.pl_debug.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let gate = {
            let mut registry = state.pl_debug.lock();
            let held = mutation::held_connection_fence(&state.pl_debug, &registry, connection_id).is_some();
            if !registry.accepting
                || (!held
                    && (registry.connection_drains.contains_key(connection_id)
                        || registry.connection_fences.contains_key(connection_id)))
            {
                return Err("The connection is being cleaned up; wait before preparing its transport".into());
            }
            if compatible_entries(&registry, connection_id, plan, claimant)? {
                None
            } else {
                Some((
                    registry
                        .connection_gates
                        .entry(connection_id.to_owned())
                        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                        .clone(),
                    held,
                ))
            }
        };
        let Some((gate, held)) = gate else {
            tokio::time::timeout_at(deadline, notified)
                .await
                .map_err(|_| "The original debugger has not finished binding its transport".to_owned())?;
            continue;
        };
        let gate = if held {
            None
        } else {
            Some(
                tokio::time::timeout_at(deadline, gate.lock_owned())
                    .await
                    .map_err(|_| "The original transport operation is still in progress".to_owned())?,
            )
        };
        let mut registry = state.pl_debug.lock();
        let held = mutation::held_connection_fence(&state.pl_debug, &registry, connection_id).is_some();
        if !registry.accepting
            || (!held
                && (registry.connection_drains.contains_key(connection_id)
                    || registry.connection_fences.contains_key(connection_id)))
        {
            return Err("The connection is being cleaned up; wait before preparing its transport".into());
        }
        if compatible_entries(&registry, connection_id, plan, claimant)? {
            drop(registry);
            drop(gate);
            continue;
        }
        if let Some(claimant) = claimant {
            let data = claimant.entry.lock();
            if data.generation != claimant.generation || data.close.is_some() || data.access_revoked {
                return Err("The original debug start was stopped before transport preparation".into());
            }
        }
        let previous = registry.transports.get(connection_id);
        let replace = previous.is_some_and(|record| record.endpoint.is_none() || !record.stamp.same_plan(plan));
        let endpoint =
            previous.filter(|record| record.stamp.same_plan(plan)).and_then(|record| record.endpoint.clone());
        if replace
            && (registry.sessions.values().any(|entry| {
                entry.start.connection_id == connection_id
                    && !claimant.is_some_and(|claimant| Arc::ptr_eq(&claimant.entry, entry))
                    && entry.lock().protects_execution()
            }) || registry.inspections.values().any(|inspection| {
                inspection.request.connection_id == connection_id && inspection.active_transport().is_some()
            }))
        {
            return Err("The original debug transport cannot be replaced by ordinary connection preparation".into());
        }
        let stamp = ConnectionTransportStamp::new(
            connection_id,
            plan.clone(),
            previous.map(|record| &record.stamp),
            endpoint.is_some(),
        );
        if let Some(claimant) = claimant {
            claimant.entry.lock().transport_stamp = Some(stamp.clone());
        }
        registry
            .transports
            .insert(connection_id.to_owned(), TransportRecord { stamp: stamp.clone(), endpoint: endpoint.clone() });
        return Ok(TransportReservation {
            registry: &state.pl_debug,
            connection_id: connection_id.to_owned(),
            stamp,
            replace,
            endpoint,
            _gate: gate,
        });
    }
}
