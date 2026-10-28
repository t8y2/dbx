use super::*;

const MUTATION_DENIED: &str = "This connection change is not allowed while a protected debugger is active";

#[derive(Clone)]
struct AcceptedMutation {
    epoch: Uuid,
    token: Uuid,
    entries: Vec<(Arc<Entry>, u64)>,
    fences: Vec<(String, Uuid)>,
}

tokio::task_local! {
    static ACCEPTED_MUTATION: AcceptedMutation;
}

pub(super) fn authorize_connection_cleanup(
    registry: &PlDebugRegistry,
    state: &RegistryState,
    connection_id: &str,
) -> Result<(), String> {
    if state.compilations.values().any(|compilation| compilation.protects_connection(connection_id)) {
        return Err(MUTATION_DENIED.into());
    }
    let protected = state.sessions.values().filter(|entry| {
        entry.start.connection_id == connection_id
            && (entry.lock().protects_execution() || retains_cleanup(state, entry))
    });
    for entry in protected {
        let accepted = ACCEPTED_MUTATION
            .try_with(|accepted| {
                accepted.epoch == registry.epoch
                    && state.mutation_permits.get(&accepted.token).is_some_and(|intent| {
                        intent.blocks_start(connection_id) || intent.connections.iter().any(|id| id == connection_id)
                    })
                    && accepted.entries.iter().any(|(original, generation)| {
                        Arc::ptr_eq(original, entry) && entry.lock().generation == *generation
                    })
            })
            .unwrap_or(false);
        if !accepted {
            return Err(MUTATION_DENIED.into());
        }
    }
    Ok(())
}

pub(super) fn held_connection_fence(
    registry: &PlDebugRegistry,
    state: &RegistryState,
    connection_id: &str,
) -> Option<Uuid> {
    ACCEPTED_MUTATION
        .try_with(|accepted| {
            if accepted.epoch != registry.epoch || !state.mutation_permits.contains_key(&accepted.token) {
                return None;
            }
            accepted.fences.iter().find_map(|(id, token)| {
                (id == connection_id && state.connection_fences.get(id) == Some(token)).then_some(*token)
            })
        })
        .ok()
        .flatten()
}

fn retains_cleanup(registry: &RegistryState, entry: &Arc<Entry>) -> bool {
    registry
        .connection_drains
        .get(&entry.start.connection_id)
        .is_some_and(|drain| drain.intent.entries.iter().any(|original| Arc::ptr_eq(original, entry)))
}

impl PlDebugMutationScope {
    fn includes(&self, entry: &Entry, data: &EntryState) -> bool {
        match self {
            Self::Connections(ids) => ids.contains(&entry.start.connection_id),
            Self::WriteProtection { connection_id, credential_owner } => {
                connection_id == &entry.start.connection_id && credential_owner == &entry.credential_owner
            }
            Self::TunnelProfiles(ids) => {
                !ids.is_empty()
                    && data
                        .source_profile_ids
                        .as_ref()
                        .is_none_or(|sources| sources.iter().any(|source| ids.contains(source)))
            }
            Self::Driver(key) => data.driver_key.as_ref().is_none_or(|original| original == key),
            Self::AllRuntimes => true,
        }
    }

    pub(super) fn blocks_start(&self, connection_id: &str) -> bool {
        match self {
            Self::Connections(ids) => ids.iter().any(|id| id == connection_id),
            Self::WriteProtection { connection_id: original, .. } => original == connection_id,
            Self::TunnelProfiles(_) => false,
            Self::Driver(_) | Self::AllRuntimes => true,
        }
    }
}

impl MutationIntent {
    pub(super) fn blocks_start(&self, connection_id: &str) -> bool {
        self.scope.blocks_start(connection_id)
            || (matches!(self.scope, PlDebugMutationScope::TunnelProfiles(_))
                && self.connections.iter().any(|id| id == connection_id))
    }
}

pub fn pl_debug_claim_mutation_core<'a>(
    state: &'a AppState,
    access: Option<&PlDebugAccess>,
    scope: PlDebugMutationScope,
) -> Result<PlDebugMutationPermit<'a>, String> {
    let mut registry = state.pl_debug.lock();
    if !registry.accepting {
        return Err("The application is shutting down".into());
    }
    if registry.compilations.values().any(|compilation| {
        compilation.matches_scope(&scope) && compilation.protects_connection(&compilation.request.connection_id)
    }) {
        return Err(MUTATION_DENIED.into());
    }
    let mut entries = Vec::new();
    for entry in registry.sessions.values() {
        let data = entry.lock();
        if !scope.includes(entry, &data) || (!data.protects_execution() && !retains_cleanup(&registry, entry)) {
            continue;
        }
        if data.access_revoked || access.is_none_or(|access| entry.owner != access.owner) {
            return Err(MUTATION_DENIED.into());
        }
        entries.push((entry.clone(), data.generation));
    }
    if let PlDebugMutationScope::Driver(key) = &scope {
        for entry in registry.sessions.values() {
            if !entries.iter().any(|(selected, _)| selected.start.connection_id == entry.start.connection_id) {
                continue;
            }
            let data = entry.lock();
            if data.driver_key.as_ref().is_some_and(|original| original != key)
                && (data.protects_execution() || retains_cleanup(&registry, entry))
            {
                return Err(MUTATION_DENIED.into());
            }
        }
    }
    let mut connections = entries.iter().map(|(entry, _)| entry.start.connection_id.clone()).collect::<Vec<_>>();
    connections.sort();
    connections.dedup();
    if matches!(scope, PlDebugMutationScope::TunnelProfiles(_)) {
        for entry in registry.sessions.values() {
            if !connections.contains(&entry.start.connection_id)
                || entries.iter().any(|(selected, _)| Arc::ptr_eq(selected, entry))
            {
                continue;
            }
            let data = entry.lock();
            if !data.protects_execution() && !retains_cleanup(&registry, entry) {
                continue;
            }
            if data.access_revoked || access.is_none_or(|access| entry.owner != access.owner) {
                return Err(MUTATION_DENIED.into());
            }
            entries.push((entry.clone(), data.generation));
        }
    }
    let token = Uuid::new_v4();
    let inspections = registry
        .inspections
        .values()
        .filter(|inspection| scope.includes_inspection(inspection))
        .cloned()
        .collect::<Vec<_>>();
    connections.extend(inspections.iter().map(|inspection| inspection.request.connection_id.clone()));
    connections.sort();
    connections.dedup();
    registry.mutation_permits.insert(token, MutationIntent { scope, connections });
    Ok(PlDebugMutationPermit { app: state, token, entries, inspections })
}

impl PlDebugPreparation {
    pub(crate) fn bind_driver(&self, state: &AppState, driver_key: &str) -> Result<(), String> {
        let registry = state.pl_debug.lock();
        let mut data = self.entry.lock();
        if data.generation != self.generation || data.close.is_some() || data.access_revoked {
            return Err("The original debug start was stopped before connection preparation".into());
        }
        if registry.mutation_permits.values().any(|intent| match &intent.scope {
            PlDebugMutationScope::Connections(ids) => ids.contains(&self.entry.start.connection_id),
            PlDebugMutationScope::WriteProtection { .. } => false,
            PlDebugMutationScope::TunnelProfiles(_) => false,
            PlDebugMutationScope::Driver(key) => key == driver_key,
            PlDebugMutationScope::AllRuntimes => true,
        }) {
            return Err("The original debug driver is being changed; wait before starting again".into());
        }
        data.driver_key = Some(driver_key.to_owned());
        drop(data);
        drop(registry);
        state.pl_debug.changed.notify_waiters();
        Ok(())
    }

    pub(crate) fn bind_profile_sources(&self, state: &AppState, sources: Vec<String>) -> Result<(), String> {
        let registry = state.pl_debug.lock();
        let mut data = self.entry.lock();
        if data.generation != self.generation || data.close.is_some() || data.access_revoked {
            return Err("The original debug start was stopped before connection preparation".into());
        }
        if registry.mutation_permits.values().any(|intent| match &intent.scope {
            PlDebugMutationScope::TunnelProfiles(ids) => sources.iter().any(|source| ids.contains(source)),
            PlDebugMutationScope::Connections(ids) => ids.contains(&self.entry.start.connection_id),
            PlDebugMutationScope::Driver(key) => data.driver_key.as_ref() == Some(key),
            PlDebugMutationScope::AllRuntimes => true,
            PlDebugMutationScope::WriteProtection { .. } => false,
        }) {
            return Err("The original debug connection is being changed; wait before starting again".into());
        }
        data.source_profile_ids = Some(sources);
        Ok(())
    }
}

impl PlDebugMutationPermit<'_> {
    pub async fn after_debug_cleanup<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.after_debug_cleanup_with_error(operation).await
    }

    pub async fn after_debug_cleanup_with_error<T, E: From<String>>(
        &self,
        operation: impl std::future::Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        let mut connections =
            self.entries.iter().map(|(entry, _)| entry.start.connection_id.clone()).collect::<Vec<_>>();
        connections.extend(self.inspections.iter().map(|inspection| inspection.request.connection_id.clone()));
        connections.sort();
        connections.dedup();
        {
            let registry = self.app.pl_debug.lock();
            if !registry.mutation_permits.contains_key(&self.token)
                || self.entries.iter().any(|(entry, generation)| entry.lock().generation != *generation)
            {
                return Err(E::from(MUTATION_DENIED.to_owned()));
            }
        }
        let accepted = AcceptedMutation {
            epoch: self.app.pl_debug.epoch,
            token: self.token,
            entries: self.entries.clone(),
            fences: Vec::new(),
        };
        ACCEPTED_MUTATION
            .scope(accepted, async {
                for inspection in &self.inspections {
                    inspection.invalidate();
                }
                let mut fences = Vec::new();
                for connection in connections {
                    fences.push(drain_connection(self.app, &connection, "runtime_changed").await.map_err(E::from)?);
                }
                let mut accepted = ACCEPTED_MUTATION.with(Clone::clone);
                accepted.fences = fences.iter().map(|fence| (fence.connection_id.clone(), fence.token)).collect();
                let result = ACCEPTED_MUTATION.scope(accepted, operation).await;
                if result.is_ok() {
                    for fence in fences {
                        fence.complete();
                    }
                }
                result
            })
            .await
    }
}

impl Drop for PlDebugMutationPermit<'_> {
    fn drop(&mut self) {
        self.app.pl_debug.lock().mutation_permits.remove(&self.token);
        self.app.pl_debug.changed.notify_waiters();
    }
}
