use super::*;
use std::collections::HashSet;
use std::io::{self, Write};
use std::time::Duration;

const CAPACITY_ERROR: &str =
    "Routine operation registry capacity exceeded; release unused comparison tasks or reduce the selection";
const RESULT_CAPACITY_ERROR: &str =
    "Routine result exceeds registry capacity; execution facts are retained, read the original operation again";

pub(in crate::schema::oracle_routines) struct RegistryLimits {
    records: usize,
    total: usize,
    single: usize,
}

impl Default for RegistryLimits {
    fn default() -> Self {
        Self { records: 1024, total: 128 * 1024 * 1024, single: 16 * 1024 * 1024 }
    }
}

pub(in crate::schema::oracle_routines) struct PreparedRoutineWrite {
    pub operation_id: String,
    pub binding: RoutineWriteBinding,
    pub supersedes: Option<String>,
}

pub(in crate::schema::oracle_routines) struct RoutineOperationPin<'a> {
    registry: &'a RoutineOperationRegistry,
    operation_id: String,
}

impl Drop for RoutineOperationPin<'_> {
    fn drop(&mut self) {
        let mut operations = self.registry.operations.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(operation) = operations.get_mut(&self.operation_id) {
            operation.inflight = operation.inflight.saturating_sub(1);
        }
        sweep(&mut operations, &HashSet::new());
    }
}

struct ByteCount {
    bytes: usize,
    limit: usize,
}

impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .bytes
            .checked_add(bytes.len())
            .filter(|value| *value <= self.limit)
            .ok_or_else(|| io::Error::other("payload exceeds capacity"))?;
        self.bytes = next;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn json_bytes(value: &impl Serialize, limit: usize) -> Result<usize, String> {
    let mut counter = ByteCount { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| CAPACITY_ERROR.to_owned())?;
    Ok(counter.bytes)
}

fn fallback_readback(identity: &RoutineIdentity) -> RoutineReadback {
    RoutineReadback {
        identity: identity.clone(),
        state: RoutineReadbackState::ReadbackFailed,
        exists: None,
        version: None,
        source: None,
        source_origin: None,
        package_companion: None,
        definition_matches: None,
        compiler_messages: Vec::new(),
        issues: vec![super::super::issue("capacity", RESULT_CAPACITY_ERROR)],
    }
}

fn charge(
    operation: &StoredOperation,
    record: &RoutineOperationRecord,
    verified: &Option<RoutineReadback>,
    acknowledged: &Option<RoutineReadback>,
    limit: usize,
) -> Result<usize, String> {
    let parts = [
        256,
        json_bytes(&record.operation_id, limit)?,
        json_bytes(&operation.owner_scope, limit)?,
        json_bytes(&operation.binding, limit)?,
        json_bytes(record, limit)?.max(operation.receipt_floor),
        json_bytes(verified, limit)?,
        json_bytes(acknowledged, limit)?,
    ];
    parts.into_iter().try_fold(0usize, |total, value| {
        total.checked_add(value).filter(|total| *total <= limit).ok_or_else(|| CAPACITY_ERROR.into())
    })
}

fn sweep(operations: &mut HashMap<String, StoredOperation>, additional_roots: &HashSet<String>) {
    let now = Instant::now();
    let mut keep = additional_roots.clone();
    let mut pending = Vec::new();
    for (id, operation) in operations.iter() {
        if operation.client_retained
            || operation.inflight > 0
            || matches!(
                operation.record.lifecycle,
                RoutineOperationLifecycle::Running | RoutineOperationLifecycle::Unproven
            )
            || operation.unclaimed_until.is_some_and(|deadline| deadline > now)
        {
            keep.insert(id.clone());
        }
    }
    pending.extend(keep.iter().cloned());
    while let Some(id) = pending.pop() {
        if let Some(operation) = operations.get(&id) {
            for prerequisite in operation
                .binding
                .prerequisite_operation_ids
                .iter()
                .chain(&operation.binding.package_effect_operation_ids)
            {
                if keep.insert(prerequisite.clone()) {
                    pending.push(prerequisite.clone());
                }
            }
        }
    }
    operations.retain(|id, _| keep.contains(id));
}

impl RoutineOperationRegistry {
    pub(in crate::schema::oracle_routines) fn adopt_pin(&self, operation_id: &str) -> RoutineOperationPin<'_> {
        RoutineOperationPin { registry: self, operation_id: operation_id.into() }
    }

    pub(in crate::schema::oracle_routines) fn pin(
        &self,
        operation_id: &str,
    ) -> Result<RoutineOperationPin<'_>, String> {
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let operation = operations
            .get_mut(operation_id)
            .filter(|operation| operation.owner_scope == current_credential_owner())
            .ok_or("Original routine operation is unavailable; do not replay the write")?;
        operation.inflight = operation.inflight.checked_add(1).ok_or("Too many routine operation waiters")?;
        Ok(self.adopt_pin(operation_id))
    }

    pub fn update_references(&self, retain: &[String], release: &[String]) -> Result<(), String> {
        if retain.len() > self.limits.records
            || release.len() > self.limits.records
            || retain.iter().chain(release).any(|id| id.len() > 128)
        {
            return Err(CAPACITY_ERROR.into());
        }
        let owner = current_credential_owner();
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        if retain.iter().any(|id| !operations.get(id).is_some_and(|operation| operation.owner_scope == owner)) {
            return Err("Routine approval is unavailable in this authenticated session".into());
        }
        for id in release {
            if let Some(operation) = operations.get_mut(id).filter(|operation| operation.owner_scope == owner) {
                operation.client_retained = false;
                operation.unclaimed_until = None;
            }
        }
        for id in retain {
            let operation = operations.get_mut(id).expect("validated under the same lock");
            operation.client_retained = true;
            operation.unclaimed_until = None;
        }
        sweep(&mut operations, &HashSet::new());
        Ok(())
    }

    pub(in crate::schema::oracle_routines) fn prepare_batch(
        &self,
        requests: Vec<PreparedRoutineWrite>,
        pins: usize,
    ) -> Result<Vec<RoutineOperationRecord>, String> {
        if requests.is_empty() || requests.len() > self.limits.records {
            return Err(CAPACITY_ERROR.into());
        }
        let owner_scope = current_credential_owner();
        let mut candidates = Vec::with_capacity(requests.len());
        let mut new_ids = HashSet::new();
        let mut supersedes_ids = HashSet::new();
        for request in requests {
            if request.operation_id.len() > 128 || !new_ids.insert(request.operation_id.clone()) {
                return Err("Duplicate or invalid routine approval ID".into());
            }
            if let Some(id) = &request.supersedes {
                if !supersedes_ids.insert(id.clone()) {
                    return Err("A routine approval cannot be superseded twice in one plan".into());
                }
            }
            let record = RoutineOperationRecord {
                operation_id: request.operation_id,
                target: request.binding.target.clone(),
                identity: request.binding.identity.clone(),
                lifecycle: RoutineOperationLifecycle::Prepared,
                dispatched: false,
                acknowledged: false,
                readback: None,
                error: None,
            };
            let mut fallback = record.clone();
            fallback.readback = Some(fallback_readback(&record.identity));
            fallback.error = Some(RESULT_CAPACITY_ERROR.into());
            let floor = json_bytes(&record, self.limits.single)?
                .max(json_bytes(&fallback, self.limits.single)?)
                .checked_add(4096)
                .ok_or(CAPACITY_ERROR)?;
            let mut operation = StoredOperation {
                binding: request.binding,
                record,
                verified_post_state: None,
                acknowledged_post_state: None,
                owner_scope: owner_scope.clone(),
                client_retained: false,
                unclaimed_until: (pins == 0).then(|| Instant::now() + Duration::from_secs(60)),
                inflight: pins,
                charge: 0,
                receipt_floor: floor,
            };
            operation.charge = charge(&operation, &operation.record, &None, &None, self.limits.single)?;
            candidates.push((operation, request.supersedes));
        }
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let mut replacements = HashMap::new();
        for (operation, supersedes) in &candidates {
            if operations.contains_key(&operation.record.operation_id) {
                return Err("Routine approval ID already exists".into());
            }
            if let Some(id) = supersedes {
                let original = operations
                    .get(id)
                    .filter(|operation| operation.owner_scope == owner_scope)
                    .ok_or("Original routine approval is unavailable; do not replace its ID")?;
                if !same_namespace_target(&operation.binding, &original.binding) {
                    return Err("A new routine draft cannot supersede another target".into());
                }
                if matches!(
                    original.record.lifecycle,
                    RoutineOperationLifecycle::Running | RoutineOperationLifecycle::Unproven
                ) {
                    return Err("Original routine request may still be running; only observe its original ID".into());
                }
                if original.record.lifecycle == RoutineOperationLifecycle::Prepared {
                    let mut record = original.record.clone();
                    record.lifecycle = RoutineOperationLifecycle::Terminal;
                    record.error = Some("Approval was superseded before dispatch".into());
                    let bytes = charge(
                        original,
                        &record,
                        &original.verified_post_state,
                        &original.acknowledged_post_state,
                        self.limits.single,
                    )?;
                    replacements.insert(id.clone(), (record, bytes));
                }
            }
            for id in &operation.binding.prerequisite_operation_ids {
                if !new_ids.contains(id)
                    && !operations.get(id).is_some_and(|operation| operation.owner_scope == owner_scope)
                {
                    return Err("Routine prerequisite approval is unavailable".into());
                }
            }
            if operation
                .binding
                .package_effect_operation_ids
                .iter()
                .any(|id| !new_ids.contains(id) || id == &operation.record.operation_id)
            {
                return Err("Package effects must refer to other approvals in the same atomic preparation batch".into());
            }
        }
        // Preserve old inputs until admission succeeds; capacity failure must not
        // invalidate approvals which the caller can still use.
        let mut inputs = supersedes_ids;
        for (operation, _) in &candidates {
            inputs.extend(operation.binding.prerequisite_operation_ids.iter().cloned());
            inputs.extend(operation.binding.package_effect_operation_ids.iter().cloned());
        }
        sweep(&mut operations, &inputs);
        let total = operations
            .iter()
            .map(|(id, operation)| replacements.get(id).map_or(operation.charge, |(_, bytes)| *bytes))
            .chain(candidates.iter().map(|(operation, _)| operation.charge))
            .try_fold(0usize, |total, bytes| {
                total.checked_add(bytes).filter(|total| *total <= self.limits.total).ok_or(CAPACITY_ERROR)
            })?;
        if operations.len() + candidates.len() > self.limits.records || total > self.limits.total {
            return Err(CAPACITY_ERROR.into());
        }
        let mut records = Vec::with_capacity(candidates.len());
        for (id, (record, bytes)) in replacements {
            let original = operations.get_mut(&id).expect("superseded input is protected under the lock");
            original.record = record;
            original.charge = bytes;
        }
        for (operation, _) in candidates {
            records.push(operation.record.clone());
            operations.insert(operation.record.operation_id.clone(), operation);
        }
        Ok(records)
    }

    pub(in crate::schema::oracle_routines) fn update_record(
        &self,
        id: &str,
        update: impl FnOnce(&mut RoutineOperationRecord),
    ) {
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        self.update_record_locked(&mut operations, id, update);
    }

    pub(super) fn update_record_locked(
        &self,
        operations: &mut HashMap<String, StoredOperation>,
        id: &str,
        update: impl FnOnce(&mut RoutineOperationRecord),
    ) {
        self.update_record_locked_with_receipt(operations, id, false, update);
    }

    pub(super) fn update_record_locked_with_receipt(
        &self,
        operations: &mut HashMap<String, StoredOperation>,
        id: &str,
        capture_receipt: bool,
        update: impl FnOnce(&mut RoutineOperationRecord),
    ) {
        sweep(operations, &HashSet::from([id.to_owned()]));
        let other_bytes = operations
            .iter()
            .filter(|(key, _)| key.as_str() != id)
            .map(|(_, operation)| operation.charge)
            .sum::<usize>();
        let Some(operation) = operations.get_mut(id) else {
            return;
        };
        let mut record = operation.record.clone();
        update(&mut record);
        let verified = if operation.verified_post_state.is_none() && record.verified() {
            record.readback.clone()
        } else {
            operation.verified_post_state.clone()
        };
        let acknowledged = if capture_receipt
            && operation.acknowledged_post_state.is_none()
            && record.lifecycle == RoutineOperationLifecycle::Terminal
            && record.dispatched
            && record.acknowledged
        {
            record.readback.clone()
        } else {
            operation.acknowledged_post_state.clone()
        };
        let limit = self.limits.single.min(self.limits.total.saturating_sub(other_bytes));
        match charge(operation, &record, &verified, &acknowledged, limit) {
            Ok(bytes) => {
                operation.record = record;
                operation.verified_post_state = verified;
                operation.acknowledged_post_state = acknowledged;
                operation.charge = bytes;
            }
            Err(_) => {
                record.readback = Some(fallback_readback(&record.identity));
                record.error = Some(RESULT_CAPACITY_ERROR.into());
                // The prepared floor reserves this bounded result, including
                // immutable identity copies and the original verified snapshot.
                operation.charge = charge(
                    operation,
                    &record,
                    &operation.verified_post_state,
                    &operation.acknowledged_post_state,
                    self.limits.single,
                )
                .expect("bounded receipt fits the approval's reserved floor");
                operation.record = record;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{binding, verified_readback};
    use super::*;

    fn request(id: &str, supersedes: Option<&str>) -> PreparedRoutineWrite {
        PreparedRoutineWrite { operation_id: id.into(), binding: binding(), supersedes: supersedes.map(str::to_owned) }
    }

    #[tokio::test]
    async fn related_package_cycles_are_retained_from_live_roots_and_reclaimed_together() {
        let registry = RoutineOperationRegistry::default();
        let mut spec = request("spec", None);
        spec.binding.identity.kind = crate::db::ObjectSourceKind::Package;
        spec.binding.package_effect_operation_ids = vec!["body".into()];
        let mut body = request("body", None);
        body.binding.identity.kind = crate::db::ObjectSourceKind::PackageBody;
        body.binding.package_effect_operation_ids = vec!["spec".into()];
        registry.prepare_batch(vec![spec, body], 0).unwrap();
        registry.update_references(&["body".into()], &["spec".into()]).unwrap();
        assert!(registry.observe("spec").operation.is_some());
        registry.update_references(&[], &["body".into()]).unwrap();
        assert!(registry.operations.lock().unwrap().is_empty());
    }

    #[test]
    fn package_effect_ids_cannot_borrow_an_unrelated_preparation_batch() {
        let registry = RoutineOperationRegistry::default();
        registry.prepare_batch(vec![request("original", None)], 0).unwrap();
        let mut body = request("body", None);
        body.binding.package_effect_operation_ids = vec!["original".into()];
        assert!(registry.prepare_batch(vec![body], 0).is_err());
        assert!(registry.observe("original").operation.is_some());
    }

    #[tokio::test]
    async fn reference_updates_are_owner_isolated_and_invalid_retains_are_atomic() {
        use crate::connection::session_credentials::with_credential_owner;
        let registry = RoutineOperationRegistry::default();
        let first = with_credential_owner(Some("first".into()), async {
            let record = registry.prepare(binding());
            registry.update_references(std::slice::from_ref(&record.operation_id), &[]).unwrap();
            record
        })
        .await;
        with_credential_owner(Some("second".into()), async {
            let second = registry.prepare(binding());
            let third = registry.prepare(binding());
            registry.update_references(std::slice::from_ref(&second.operation_id), &[]).unwrap();
            assert!(registry
                .update_references(
                    &[third.operation_id.clone(), first.operation_id.clone()],
                    std::slice::from_ref(&second.operation_id)
                )
                .is_err());
            assert!(registry
                .update_references(
                    &[third.operation_id.clone(), "missing".into()],
                    std::slice::from_ref(&second.operation_id)
                )
                .is_err());
            {
                let operations = registry.operations.lock().unwrap();
                assert!(operations[&second.operation_id].client_retained);
                assert!(!operations[&third.operation_id].client_retained);
            }
            registry.update_references(&[], std::slice::from_ref(&first.operation_id)).unwrap();
            assert!(registry.observe(&first.operation_id).operation.is_none());
        })
        .await;
        with_credential_owner(Some("first".into()), async {
            assert!(registry.observe(&first.operation_id).operation.is_some());
            assert!(registry.operations.lock().unwrap()[&first.operation_id].client_retained);
        })
        .await;
    }

    #[test]
    fn release_reclaims_unused_approval_and_missing_id_never_replays() {
        let registry = RoutineOperationRegistry::default();
        let record = registry.prepare(binding());
        registry.update_references(&[], std::slice::from_ref(&record.operation_id)).unwrap();
        assert!(registry.observe(&record.operation_id).operation.is_none());
        assert!(registry.begin(&record.operation_id, "approved SQL").is_err());
    }

    #[test]
    fn retained_approval_and_prerequisite_closure_survive_until_last_reference() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        let mut next = binding();
        next.prerequisite_operation_ids.push(first.operation_id.clone());
        let second = registry.prepare(next);
        registry
            .update_references(std::slice::from_ref(&second.operation_id), std::slice::from_ref(&first.operation_id))
            .unwrap();
        assert!(registry.observe(&first.operation_id).operation.is_some());
        registry.update_references(&[], std::slice::from_ref(&second.operation_id)).unwrap();
        assert!(registry.operations.lock().unwrap().is_empty());
    }

    #[test]
    fn unclaimed_grace_expires_but_client_reference_does_not() {
        let registry = RoutineOperationRegistry::default();
        let orphan = registry.prepare(binding());
        let retained = registry.prepare(binding());
        registry.update_references(std::slice::from_ref(&retained.operation_id), &[]).unwrap();
        {
            let mut operations = registry.operations.lock().unwrap();
            operations.get_mut(&orphan.operation_id).unwrap().unclaimed_until =
                Some(Instant::now() - Duration::from_secs(1));
        }
        registry.update_references(&[], &[]).unwrap();
        assert!(registry.observe(&orphan.operation_id).operation.is_none());
        assert!(registry.observe(&retained.operation_id).operation.is_some());
    }

    #[test]
    fn worker_and_response_pins_cover_terminal_readback_and_final_clone() {
        let registry = RoutineOperationRegistry::default();
        let record = registry.prepare(binding());
        assert!(matches!(
            registry.begin(&record.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        let worker = registry.adopt_pin(&record.operation_id);
        let response = registry.adopt_pin(&record.operation_id);
        registry.mark_dispatched(&record.operation_id).unwrap();
        registry.terminal(&record.operation_id, true, None, None);
        registry.update_references(&[], std::slice::from_ref(&record.operation_id)).unwrap();
        assert!(registry.observe(&record.operation_id).operation.is_some());
        registry.update_readback(&record.operation_id, verified_readback());
        drop(worker);
        let final_record = registry.observe(&record.operation_id).operation.unwrap();
        assert!(final_record.verified());
        drop(response);
        assert!(registry.observe(&record.operation_id).operation.is_none());
        assert!(final_record.verified());
    }

    #[test]
    fn unproven_is_not_reclaimed_when_waiters_and_client_release() {
        let registry = RoutineOperationRegistry::default();
        let record = registry.prepare(binding());
        registry.begin(&record.operation_id, "approved SQL").unwrap();
        let worker = registry.adopt_pin(&record.operation_id);
        let response = registry.adopt_pin(&record.operation_id);
        registry.mark_dispatched(&record.operation_id).unwrap();
        registry.waiting_lost(&record.operation_id, "outcome unknown".into());
        registry.update_references(&[], std::slice::from_ref(&record.operation_id)).unwrap();
        drop(worker);
        drop(response);
        assert_eq!(registry.observe(&record.operation_id).lifecycle, RoutineOperationLifecycle::Unproven);
    }

    #[test]
    fn batch_capacity_failure_leaves_no_partial_insert_or_supersede() {
        let mut registry = RoutineOperationRegistry::default();
        registry.limits.records = 2;
        let original = registry.prepare(binding());
        assert!(registry
            .prepare_batch(vec![request("new-one", Some(&original.operation_id)), request("new-two", None)], 0)
            .is_err());
        assert_eq!(registry.operations.lock().unwrap().len(), 1);
        assert_eq!(registry.observe(&original.operation_id).lifecycle, RoutineOperationLifecycle::Prepared);
        assert!(registry.observe("new-one").operation.is_none());
    }

    #[test]
    fn ordinary_hundred_step_batch_does_not_reserve_sixteen_mib_per_step() {
        let registry = RoutineOperationRegistry::default();
        let records =
            registry.prepare_batch((0..100).map(|index| request(&format!("step-{index}"), None)).collect(), 0).unwrap();
        assert_eq!(records.len(), 100);
        let retained_bytes =
            registry.operations.lock().unwrap().values().map(|operation| operation.charge).sum::<usize>();
        assert!(retained_bytes < 2 * 1024 * 1024);
    }

    #[test]
    fn oversized_first_verified_readback_keeps_ack_without_claiming_verification() {
        let mut registry = RoutineOperationRegistry::default();
        let record = registry.prepare(binding());
        registry.begin(&record.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&record.operation_id).unwrap();
        registry.limits.single = registry.operations.lock().unwrap()[&record.operation_id].charge + 1024;
        let mut readback = verified_readback();
        readback.source = Some("x".repeat(8192));
        registry.terminal(&record.operation_id, true, Some(readback), None);
        let observed = registry.observe(&record.operation_id).operation.unwrap();
        assert!(observed.acknowledged && observed.dispatched);
        assert_eq!(observed.lifecycle, RoutineOperationLifecycle::Terminal);
        assert!(!observed.verified());
        assert_eq!(observed.readback.unwrap().state, RoutineReadbackState::ReadbackFailed);
        assert!(registry.operations.lock().unwrap()[&record.operation_id].verified_post_state.is_none());
    }

    #[test]
    fn later_oversized_readback_preserves_first_verified_and_stays_within_old_charge() {
        let registry = RoutineOperationRegistry::default();
        let record = registry.prepare(binding());
        registry.begin(&record.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&record.operation_id).unwrap();
        registry.terminal(&record.operation_id, true, Some(verified_readback()), None);
        let before = registry.operations.lock().unwrap()[&record.operation_id].charge;
        let mut readback = verified_readback();
        readback.source = Some("x".repeat(16 * 1024 * 1024));
        registry.update_readback(&record.operation_id, readback);
        let operations = registry.operations.lock().unwrap();
        let operation = &operations[&record.operation_id];
        assert!(!operation.record.verified());
        assert_eq!(operation.verified_post_state.as_ref().unwrap().source.as_deref(), Some("expected source"));
        assert!(operation.charge <= before);
    }

    #[test]
    fn recovery_keeps_acknowledged_invalid_post_state_instead_of_later_observations() {
        let registry = RoutineOperationRegistry::default();
        let record = registry.prepare(binding());
        registry.begin(&record.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&record.operation_id).unwrap();
        registry.terminal(&record.operation_id, true, None, None);
        assert!(registry.recovery_post_state(&record.operation_id).is_err());
        let mut original = verified_readback();
        original.state = RoutineReadbackState::Invalid;
        registry.terminal(&record.operation_id, true, Some(original.clone()), None);
        let mut later = verified_readback();
        later.source = Some("third-party definition".into());
        registry.update_readback(&record.operation_id, later);
        assert_eq!(registry.recovery_post_state(&record.operation_id).unwrap(), original);
        assert_eq!(
            registry.observe(&record.operation_id).operation.unwrap().readback.unwrap().source.as_deref(),
            Some("third-party definition")
        );
    }

    #[test]
    fn observation_cannot_create_recovery_receipt_for_unknown_or_rejected_write() {
        for rejected in [false, true] {
            let registry = RoutineOperationRegistry::default();
            let record = registry.prepare(binding());
            registry.begin(&record.operation_id, "approved SQL").unwrap();
            registry.mark_dispatched(&record.operation_id).unwrap();
            if rejected {
                registry.terminal(&record.operation_id, false, Some(verified_readback()), None);
            } else {
                registry.waiting_lost(&record.operation_id, "unknown".into());
            }
            registry.update_readback(&record.operation_id, verified_readback());
            assert!(registry.recovery_post_state(&record.operation_id).is_err());
        }
    }

    #[test]
    fn private_binding_duplicates_and_nested_credentials_count_without_logging_them() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        let mut larger = binding();
        larger.expected_config.password = "p".repeat(1000);
        larger.goal = RoutineReadbackGoal::Definition { sql: "q".repeat(1000) };
        let second = registry.prepare(larger);
        let operations = registry.operations.lock().unwrap();
        assert!(operations[&second.operation_id].charge >= operations[&first.operation_id].charge + 2000);
    }
}
