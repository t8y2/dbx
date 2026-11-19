use super::{RoutineEndpoint, RoutineIdentity, RoutineReadback, RoutineReadbackGoal, RoutineReadbackState};
use crate::connection::session_credentials::current_credential_owner;
use crate::models::connection::ConnectionConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

mod retention;
use retention::RegistryLimits;
pub(super) use retention::{PreparedRoutineWrite, RoutineOperationPin};

#[derive(Clone, Serialize)]
pub(super) struct RoutineWriteBinding {
    pub target: RoutineEndpoint,
    pub identity: RoutineIdentity,
    pub sql: String,
    pub goal: RoutineReadbackGoal,
    pub expected_config: ConnectionConfig,
    pub require_absent: bool,
    pub compare: Option<super::plan::ComparePreflight>,
    pub prerequisite_operation_ids: Vec<String>,
    pub package_effect_operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutineOperationLifecycle {
    Prepared,
    Running,
    Terminal,
    Unproven,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOperationRecord {
    pub operation_id: String,
    pub target: RoutineEndpoint,
    pub identity: RoutineIdentity,
    pub lifecycle: RoutineOperationLifecycle,
    pub dispatched: bool,
    pub acknowledged: bool,
    pub readback: Option<RoutineReadback>,
    pub error: Option<String>,
}

impl RoutineOperationRecord {
    pub fn verified(&self) -> bool {
        self.lifecycle == RoutineOperationLifecycle::Terminal
            && self.dispatched
            && self.acknowledged
            && self.readback.as_ref().is_some_and(|readback| readback.state == RoutineReadbackState::Verified)
    }

    pub fn failure_message(&self) -> String {
        let mut details = vec![format!(
            "Routine {}.{} operation {}: {:?}",
            self.identity.owner, self.identity.name, self.operation_id, self.lifecycle
        )];
        if let Some(error) = &self.error {
            details.push(error.clone());
        }
        if let Some(readback) = &self.readback {
            details.push(format!("Target verification: {:?}", readback.state));
            details.extend(readback.compiler_messages.iter().map(|message| {
                format!("{} {}:{} {}", message.attribute, message.line, message.position, message.text)
            }));
            details.extend(readback.issues.iter().map(|issue| issue.message.clone()));
            if let Some(companion) = &readback.package_companion {
                details.push(format!("Package companion {:?}: {:?}", companion.identity.kind, companion.state));
                details.extend(companion.compiler_messages.iter().map(|message| {
                    format!("{} {}:{} {}", message.attribute, message.line, message.position, message.text)
                }));
                details.extend(companion.issues.iter().map(|issue| issue.message.clone()));
            }
        }
        details.join("\n")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOperationObservation {
    pub operation: Option<RoutineOperationRecord>,
    pub lifecycle: RoutineOperationLifecycle,
    pub error: Option<String>,
}

struct StoredOperation {
    binding: RoutineWriteBinding,
    record: RoutineOperationRecord,
    // Later observations may describe a different version of the same object.
    // Dependents remain bound to the first fully verified deployment result.
    verified_post_state: Option<RoutineReadback>,
    acknowledged_post_state: Option<RoutineReadback>,
    // Web session tokens remain private, in memory, and outside Debug/Serialize.
    owner_scope: Option<String>,
    client_retained: bool,
    unclaimed_until: Option<Instant>,
    inflight: usize,
    charge: usize,
    receipt_floor: usize,
}

pub struct RoutineOperationRegistry {
    operations: Mutex<HashMap<String, StoredOperation>>,
    limits: RegistryLimits,
}

impl Default for RoutineOperationRegistry {
    fn default() -> Self {
        Self { operations: Mutex::new(HashMap::new()), limits: RegistryLimits::default() }
    }
}

pub(super) enum BeginRoutineOperation {
    Dispatch(Box<RoutineWriteBinding>),
    Existing(Box<RoutineOperationRecord>),
}

fn same_namespace_target(left: &RoutineWriteBinding, right: &RoutineWriteBinding) -> bool {
    if left.target.database != right.target.database
        || left.identity.owner != right.identity.owner
        || left.identity.name != right.identity.name
    {
        return false;
    }
    if left.target.connection_id == right.target.connection_id {
        return true;
    }
    // Authentication does not create a separate target namespace. Keep routing
    // fields (including the OB tenant/cluster suffix), not the login account.
    let normalize = |config: &ConnectionConfig| {
        let mut config = config.clone();
        config.id.clear();
        config.password.clear();
        config.save_password = false;
        config.username = if config.db_type == crate::models::connection::DatabaseType::OceanbaseOracle {
            config.username.split_once('@').map(|(_, tenant)| format!("@{tenant}")).unwrap_or_default()
        } else {
            String::new()
        };
        config.sysdba = false;
        config
    };
    crate::connection::connection_configs_session_credentials_compatible(
        &normalize(&left.expected_config),
        &normalize(&right.expected_config),
    )
}

impl RoutineOperationRegistry {
    #[cfg(test)]
    pub(super) fn prepare(&self, binding: RoutineWriteBinding) -> RoutineOperationRecord {
        self.prepare_replacing(binding, None).expect("a new routine approval does not supersede another operation")
    }

    pub(super) fn prepare_replacing(
        &self,
        binding: RoutineWriteBinding,
        supersedes: Option<&str>,
    ) -> Result<RoutineOperationRecord, String> {
        let mut records = self.prepare_batch(
            vec![PreparedRoutineWrite {
                operation_id: uuid::Uuid::new_v4().to_string(),
                binding,
                supersedes: supersedes.map(str::to_owned),
            }],
            0,
        )?;
        Ok(records.remove(0))
    }

    pub fn observe(&self, operation_id: &str) -> RoutineOperationObservation {
        match self.operations.lock().unwrap_or_else(|error| error.into_inner()).get(operation_id) {
            Some(operation) if operation.owner_scope == current_credential_owner() => RoutineOperationObservation {
                operation: Some(operation.record.clone()),
                lifecycle: operation.record.lifecycle,
                error: operation.record.error.clone(),
            },
            _ => RoutineOperationObservation {
                operation: None,
                lifecycle: RoutineOperationLifecycle::Unproven,
                error: Some("Original routine execution record is unavailable; do not replay the write".into()),
            },
        }
    }

    pub(super) fn begin(&self, operation_id: &str, approved_sql: &str) -> Result<BeginRoutineOperation, String> {
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let operation =
            operations.get(operation_id).ok_or("Original routine operation is unavailable; its outcome is unproven")?;
        if operation.owner_scope != current_credential_owner() {
            return Err("Routine operation is unavailable in this authenticated session".into());
        }
        if operation.binding.sql != approved_sql {
            return Err("Routine approval does not match the edited SQL; validate a new draft".into());
        }
        if operation.record.lifecycle != RoutineOperationLifecycle::Prepared {
            return Ok(BeginRoutineOperation::Existing(Box::new(operation.record.clone())));
        }
        if operation.binding.prerequisite_operation_ids.iter().any(|id| {
            !operations.get(id).is_some_and(|prerequisite| {
                prerequisite.owner_scope == operation.owner_scope && prerequisite.record.verified()
            })
        }) {
            self.update_record_locked(&mut operations, operation_id, |record| {
                record.lifecycle = RoutineOperationLifecycle::Terminal;
                record.error = Some("A prerequisite routine step is not verified; validate the remaining draft without replaying completed steps".into());
            });
            return Ok(BeginRoutineOperation::Existing(Box::new(operations[operation_id].record.clone())));
        }
        if let Some(active) = operations.values().find(|other| {
            matches!(other.record.lifecycle, RoutineOperationLifecycle::Running | RoutineOperationLifecycle::Unproven)
                && same_namespace_target(&operation.binding, &other.binding)
        }) {
            let error = if active.owner_scope == operation.owner_scope {
                format!(
                    "Routine target is held by operation {}; establish its termination before another write",
                    active.record.operation_id
                )
            } else {
                "Routine target has an unresolved operation in another authenticated session".into()
            };
            self.update_record_locked(&mut operations, operation_id, |record| {
                record.lifecycle = RoutineOperationLifecycle::Terminal;
                record.error = Some(error);
            });
            return Ok(BeginRoutineOperation::Existing(Box::new(operations[operation_id].record.clone())));
        }
        let operation = operations.get_mut(operation_id).expect("operation was checked under this lock");
        // One pin belongs to the independent worker, one to its response waiter.
        operation.inflight = operation.inflight.checked_add(2).ok_or("Too many routine operation waiters")?;
        let binding = operation.binding.clone();
        self.update_record_locked(&mut operations, operation_id, |record| {
            record.lifecycle = RoutineOperationLifecycle::Running
        });
        Ok(BeginRoutineOperation::Dispatch(Box::new(binding)))
    }

    pub(super) fn binding_for_readback(&self, operation_id: &str) -> Result<RoutineWriteBinding, String> {
        self.operations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(operation_id)
            .filter(|operation| operation.owner_scope == current_credential_owner())
            .map(|operation| operation.binding.clone())
            .ok_or_else(|| "Original routine operation is unavailable; do not replay the write".into())
    }

    pub(super) fn prerequisites_for_write(
        &self,
        operation_id: &str,
    ) -> Result<Vec<(RoutineWriteBinding, RoutineReadback)>, String> {
        let operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let operation = operations
            .get(operation_id)
            .filter(|operation| operation.owner_scope == current_credential_owner())
            .ok_or("Original routine operation is unavailable; do not replay the write")?;
        operation.binding.prerequisite_operation_ids.iter().map(|id| {
            let prerequisite = operations.get(id).filter(|prerequisite| {
                prerequisite.owner_scope == operation.owner_scope
                    && prerequisite.record.verified()
                    && prerequisite.binding.target == operation.binding.target
                    && prerequisite.binding.expected_config == operation.binding.expected_config
            }).ok_or("A prerequisite routine has no verified result on the original target; validate the remaining draft")?;
            let before = prerequisite.verified_post_state.clone()
                .ok_or("The prerequisite's verified deployment snapshot is unavailable; do not replay completed steps")?;
            Ok((prerequisite.binding.clone(), before))
        }).collect()
    }

    pub(super) fn package_effects_for_write(
        &self,
        operation_id: &str,
    ) -> Result<Vec<(RoutineWriteBinding, RoutineReadback)>, String> {
        let operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let operation = operations
            .get(operation_id)
            .filter(|operation| operation.owner_scope == current_credential_owner())
            .ok_or("Original package operation is unavailable; do not replay the write")?;
        let mut effects = Vec::new();
        for id in &operation.binding.package_effect_operation_ids {
            let related = operations
                .get(id)
                .filter(|related| {
                    related.owner_scope == operation.owner_scope
                        && related.binding.target == operation.binding.target
                        && related.binding.expected_config == operation.binding.expected_config
                })
                .ok_or(
                    "An approved package step is unavailable on the original target; validate the remaining draft",
                )?;
            match related.record.lifecycle {
                RoutineOperationLifecycle::Prepared => {},
                RoutineOperationLifecycle::Running | RoutineOperationLifecycle::Unproven => return Err("An approved related package step has not established its terminal result; observe its original operation ID".into()),
                RoutineOperationLifecycle::Terminal if !related.record.dispatched => return Err("A related package approval did not complete; validate the remaining plan without replaying completed steps".into()),
                RoutineOperationLifecycle::Terminal if related.record.verified() => effects.push((related.binding.clone(),related.verified_post_state.clone().ok_or("The related package step has no immutable verified pair result")?)),
                RoutineOperationLifecycle::Terminal => return Err("An approved package step failed verification; correct its body or refresh the remaining plan without replaying completed steps".into()),
            }
        }
        Ok(effects)
    }

    pub(super) fn mark_dispatched(&self, operation_id: &str) -> Result<(), String> {
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let operation = operations.get(operation_id).ok_or("Routine operation record is unavailable")?;
        if operation.record.lifecycle != RoutineOperationLifecycle::Running || operation.record.dispatched {
            return Err("Routine operation is not awaiting its first dispatch".into());
        }
        self.update_record_locked(&mut operations, operation_id, |record| record.dispatched = true);
        Ok(())
    }

    pub(super) fn terminal(
        &self,
        operation_id: &str,
        acknowledged: bool,
        readback: Option<RoutineReadback>,
        error: Option<String>,
    ) {
        let mut operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        self.update_record_locked_with_receipt(&mut operations, operation_id, true, |record| {
            record.lifecycle = RoutineOperationLifecycle::Terminal;
            record.acknowledged = acknowledged;
            record.readback = readback;
            record.error = error;
        });
    }

    pub(super) fn recovery_post_state(&self, operation_id: &str) -> Result<RoutineReadback, String> {
        let operations = self.operations.lock().unwrap_or_else(|error| error.into_inner());
        let operation = operations
            .get(operation_id)
            .filter(|operation| operation.owner_scope == current_credential_owner())
            .ok_or("Original operation is unavailable; only observe its original ID")?;
        if operation.record.lifecycle != RoutineOperationLifecycle::Terminal
            || !operation.record.dispatched
            || !operation.record.acknowledged
        {
            return Err("Recovery requires an acknowledged terminal write on the original target".into());
        }
        operation
            .acknowledged_post_state
            .clone()
            .ok_or("The acknowledged write has no immutable post-state; refresh and review the target instead".into())
    }

    pub(super) fn not_started(&self, operation_id: &str, error: String) {
        self.update_record(operation_id, |record| {
            record.lifecycle = RoutineOperationLifecycle::Terminal;
            record.dispatched = false;
            record.error = Some(error);
        });
    }

    pub(super) fn waiting_lost(&self, operation_id: &str, error: String) {
        self.update_record(operation_id, |record| {
            if record.lifecycle != RoutineOperationLifecycle::Terminal {
                record.lifecycle = if record.dispatched {
                    RoutineOperationLifecycle::Unproven
                } else {
                    RoutineOperationLifecycle::Terminal
                };
                record.error = Some(error);
            }
        });
    }

    pub(super) fn update_readback(&self, operation_id: &str, readback: RoutineReadback) {
        self.update_record(operation_id, |record| {
            // Current object contents are not evidence that the original request ended.
            record.readback = Some(readback);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ObjectSourceKind;
    use crate::models::connection::DatabaseType;

    pub(super) fn binding() -> RoutineWriteBinding {
        RoutineWriteBinding { target: RoutineEndpoint { connection_id: "target".into(), database: "tenant".into(), schema: "OWNER".into(), database_type: DatabaseType::OceanbaseOracle, generation: 1 },
            identity: RoutineIdentity { owner: "OWNER".into(), name: "Shared.Name".into(), kind: ObjectSourceKind::Function }, sql: "approved SQL".into(), goal: RoutineReadbackGoal::Inspect,
            expected_config: serde_json::from_value(serde_json::json!({"id":"target", "name":"test", "db_type": DatabaseType::OceanbaseOracle, "host":"localhost", "port":2881, "username":"OWNER", "password":"", "database":null})).unwrap(), require_absent: false, compare: None, prerequisite_operation_ids: Vec::new(), package_effect_operation_ids:Vec::new() }
    }

    pub(super) fn verified_readback() -> RoutineReadback {
        RoutineReadback {
            identity: binding().identity,
            state: RoutineReadbackState::Verified,
            exists: Some(true),
            version: None,
            source: Some("expected source".into()),
            source_origin: None,
            package_companion: None,
            definition_matches: Some(true),
            compiler_messages: Vec::new(),
            issues: Vec::new(),
        }
    }

    #[test]
    fn package_and_body_share_the_existing_physical_namespace_lock_without_a_second_lock_key() {
        let registry = RoutineOperationRegistry::default();
        let mut specification = binding();
        specification.identity.kind = crate::db::ObjectSourceKind::Package;
        let specification = registry.prepare(specification);
        registry.begin(&specification.operation_id, "approved SQL").unwrap();
        let mut body = binding();
        body.identity.kind = crate::db::ObjectSourceKind::PackageBody;
        body.target.connection_id = "another-connection".into();
        body.expected_config.id = "another-connection".into();
        body.expected_config.username = "ANOTHER_LOGIN".into();
        for unknown in [false, true] {
            if unknown {
                registry.mark_dispatched(&specification.operation_id).unwrap();
                registry.waiting_lost(&specification.operation_id, "outcome unknown".into());
            }
            let body = registry.prepare(body.clone());
            assert!(
                matches!(registry.begin(&body.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if record.lifecycle == RoutineOperationLifecycle::Terminal && !record.dispatched && record.error.as_deref().is_some_and(|error| error.contains("held")))
            );
        }
    }

    #[test]
    fn oversized_approval_is_rejected_without_retaining_its_payload() {
        let registry = RoutineOperationRegistry::default();
        let mut input = binding();
        input.sql = "x".repeat(16 * 1024 * 1024);
        assert!(registry.prepare_replacing(input, None).is_err());
        assert!(registry.operations.lock().unwrap().is_empty());
    }

    #[test]
    fn duplicate_id_returns_the_same_operation_without_a_second_dispatch() {
        let registry = RoutineOperationRegistry::default();
        let operation = registry.prepare(binding());
        assert!(matches!(
            registry.begin(&operation.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        registry.mark_dispatched(&operation.operation_id).unwrap();
        assert!(
            matches!(registry.begin(&operation.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if record.dispatched)
        );
        assert!(registry.mark_dispatched(&operation.operation_id).is_err());
        assert!(registry.begin(&operation.operation_id, "different SQL").is_err());
    }

    #[test]
    fn namespace_lock_ignores_kind_and_survives_unknown_readback() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        assert!(matches!(
            registry.begin(&first.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        registry.mark_dispatched(&first.operation_id).unwrap();
        registry.waiting_lost(&first.operation_id, "transport ended without terminal evidence".into());
        registry.update_readback(&first.operation_id, verified_readback());
        let other = RoutineWriteBinding {
            identity: RoutineIdentity { kind: ObjectSourceKind::Procedure, ..binding().identity },
            ..binding()
        };
        let second = registry.prepare(other);
        assert!(
            matches!(registry.begin(&second.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if record.lifecycle == RoutineOperationLifecycle::Terminal && !record.dispatched)
        );
        let observed = registry.observe(&first.operation_id);
        assert_eq!(observed.lifecycle, RoutineOperationLifecycle::Unproven);
        assert!(!observed.operation.unwrap().verified());
        registry.terminal(&first.operation_id, true, Some(verified_readback()), None);
        assert!(
            matches!(registry.begin(&second.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if !record.dispatched)
        );
        let third = registry.prepare(binding());
        assert!(matches!(
            registry.begin(&third.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
    }

    #[test]
    fn lost_record_is_unproven_and_never_becomes_a_new_dispatch() {
        let registry = RoutineOperationRegistry::default();
        assert_eq!(registry.observe("old-operation-id").lifecycle, RoutineOperationLifecycle::Unproven);
        assert!(registry.begin("old-operation-id", "approved SQL").is_err());
        assert!(registry.operations.lock().unwrap().is_empty());
    }

    #[test]
    fn preflight_failure_has_no_dispatch_and_does_not_hold_the_target() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        registry.begin(&first.operation_id, "approved SQL").unwrap();
        registry.waiting_lost(&first.operation_id, "preflight failed before dispatch".into());
        let observed = registry.observe(&first.operation_id).operation.unwrap();
        assert!(!observed.dispatched && !observed.verified());
        assert_eq!(observed.lifecycle, RoutineOperationLifecycle::Terminal);
        let second = registry.prepare(binding());
        assert!(matches!(
            registry.begin(&second.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
    }

    #[test]
    fn verified_object_without_write_acknowledgement_does_not_count_as_deployed() {
        let registry = RoutineOperationRegistry::default();
        let operation = registry.prepare(binding());
        registry.begin(&operation.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&operation.operation_id).unwrap();
        registry.terminal(&operation.operation_id, false, Some(verified_readback()), Some("DDL was rejected".into()));
        assert!(!registry.observe(&operation.operation_id).operation.unwrap().verified());
    }

    #[tokio::test]
    async fn authenticated_sessions_cannot_observe_or_dispatch_each_others_operations() {
        use crate::connection::session_credentials::with_credential_owner;
        let registry = RoutineOperationRegistry::default();
        let first = with_credential_owner(Some("first-owner".into()), async { registry.prepare(binding()) }).await;
        with_credential_owner(Some("second-owner".into()), async {
            assert!(registry.observe(&first.operation_id).operation.is_none());
            assert!(registry.begin(&first.operation_id, "approved SQL").is_err());
        })
        .await;
        with_credential_owner(Some("first-owner".into()), async {
            assert!(registry.observe(&first.operation_id).operation.is_some());
        })
        .await;
    }

    #[test]
    fn saved_endpoint_aliases_cannot_bypass_an_unknown_namespace_hold() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        registry.begin(&first.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&first.operation_id).unwrap();
        registry.waiting_lost(&first.operation_id, "original request is unresolved".into());
        let mut alias = binding();
        alias.target.connection_id = "another-saved-connection".into();
        alias.expected_config.id = alias.target.connection_id.clone();
        alias.expected_config.name = "Different display name".into();
        alias.expected_config.password = "new runtime password".into();
        let second = registry.prepare(alias.clone());
        assert!(
            matches!(registry.begin(&second.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if !record.dispatched)
        );
        alias.expected_config.host = "different-server".into();
        let separate = registry.prepare(alias);
        assert!(matches!(
            registry.begin(&separate.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
    }

    #[test]
    fn review_regression_different_accounts_share_the_same_unknown_object_hold() {
        let registry = RoutineOperationRegistry::default();
        let mut original = binding();
        original.expected_config.username = "FIRST@oracletest".into();
        let first = registry.prepare(original);
        registry.begin(&first.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&first.operation_id).unwrap();
        registry.waiting_lost(&first.operation_id, "original request is unresolved".into());

        let mut alias = binding();
        alias.target.connection_id = "other-account".into();
        alias.expected_config.id = alias.target.connection_id.clone();
        alias.expected_config.username = "SECOND@oracletest".into();
        let second = registry.prepare(alias.clone());
        assert!(matches!(
            registry.begin(&second.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Existing(record) if !record.dispatched && record.lifecycle == RoutineOperationLifecycle::Terminal
        ));
        alias.expected_config.host = "different-server".into();
        let separate = registry.prepare(alias.clone());
        assert!(matches!(
            registry.begin(&separate.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        alias.expected_config.host = "localhost".into();
        alias.target.connection_id = "other-tenant".into();
        alias.expected_config.id = alias.target.connection_id.clone();
        alias.expected_config.username = "SECOND@another-tenant".into();
        let other_tenant = registry.prepare(alias);
        assert!(matches!(
            registry.begin(&other_tenant.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
    }

    #[test]
    fn review_regression_native_oracle_accounts_do_not_change_the_target_lock() {
        let registry = RoutineOperationRegistry::default();
        let mut original = binding();
        original.target.database_type = DatabaseType::Oracle;
        original.expected_config.db_type = DatabaseType::Oracle;
        original.expected_config.username = "FIRST".into();
        let first = registry.prepare(original.clone());
        registry.begin(&first.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&first.operation_id).unwrap();
        registry.waiting_lost(&first.operation_id, "original request is unresolved".into());
        original.target.connection_id = "second-account".into();
        original.expected_config.id = original.target.connection_id.clone();
        original.expected_config.username = "SECOND".into();
        original.expected_config.sysdba = true;
        let second = registry.prepare(original);
        assert!(
            matches!(registry.begin(&second.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if !record.dispatched)
        );
    }

    #[test]
    fn replacing_an_unstarted_approval_atomically_disables_its_late_execute_request() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        let second = registry.prepare_replacing(binding(), Some(&first.operation_id)).unwrap();
        assert!(
            matches!(registry.begin(&first.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if !record.dispatched && record.lifecycle == RoutineOperationLifecycle::Terminal)
        );
        assert!(matches!(
            registry.begin(&second.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        registry.mark_dispatched(&second.operation_id).unwrap();
        registry.waiting_lost(&second.operation_id, "original request may still run".into());
        assert!(registry.prepare_replacing(binding(), Some(&second.operation_id)).is_err());
    }

    #[test]
    fn plan_prerequisites_are_enforced_by_core_not_frontend_order() {
        let registry = RoutineOperationRegistry::default();
        let first = registry.prepare(binding());
        let mut dependent = binding();
        dependent.identity.name = "Caller".into();
        dependent.prerequisite_operation_ids = vec![first.operation_id.clone()];
        let early = registry.prepare(dependent.clone());
        assert!(
            matches!(registry.begin(&early.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if !record.dispatched && record.lifecycle == RoutineOperationLifecycle::Terminal)
        );
        registry.begin(&first.operation_id, "approved SQL").unwrap();
        registry.mark_dispatched(&first.operation_id).unwrap();
        registry.terminal(&first.operation_id, true, Some(verified_readback()), None);
        let approved = registry.prepare(dependent);
        assert!(matches!(
            registry.begin(&approved.operation_id, "approved SQL").unwrap(),
            BeginRoutineOperation::Dispatch(_)
        ));
        assert!(
            matches!(registry.begin(&early.operation_id, "approved SQL").unwrap(), BeginRoutineOperation::Existing(record) if !record.dispatched)
        );
    }
}
