use arc_swap::ArcSwap;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

use crate::config::layer::ConfigTree;
#[cfg(test)]
use crate::config::layer::LayerConfig;
use crate::storage::Storage;

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// 16.1 — Config Change Audit & Version Management
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigAuditEntry {
    pub id: String,
    pub timestamp: String,
    pub operator: String,
    pub reason: String,
    pub key_path: String,
    pub change_diff: serde_json::Value,
    pub config_snapshot: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigVersionSnapshot {
    pub id: String,
    pub key_path: String,
    pub version: u64,
    pub snapshot_json: serde_json::Value,
    pub checksum: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditQuery {
    pub key_path: Option<String>,
    pub operator: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditSummary {
    pub total_entries: usize,
    pub entries: Vec<ConfigAuditEntry>,
}

pub struct ConfigAuditor {
    storage: Arc<Storage>,
}

impl ConfigAuditor {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }

    pub async fn record_change(
        &self,
        operator: &str,
        reason: &str,
        key_path: &str,
        change_diff: serde_json::Value,
        config_snapshot: serde_json::Value,
    ) -> Result<ConfigAuditEntry, String> {
        let entry = ConfigAuditEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            operator: operator.to_string(),
            reason: reason.to_string(),
            key_path: key_path.to_string(),
            change_diff,
            config_snapshot,
        };
        self.storage.save_audit_entry(&entry).await?;
        Ok(entry)
    }

    pub async fn query_history(&self, query: &AuditQuery) -> Result<AuditSummary, String> {
        self.storage.query_audit_entries(query).await
    }

    pub async fn save_snapshot(&self, key_path: &str, tree: &ConfigTree) -> Result<ConfigVersionSnapshot, String> {
        let snapshot_json = serde_json::to_value(tree).map_err(|e| format!("serialize config tree: {e}"))?;
        let json_bytes = serde_json::to_vec(&snapshot_json).map_err(|e| format!("json bytes: {e}"))?;
        let checksum = hex_encode(&Sha256::digest(&json_bytes));
        let version = self.storage.next_config_version(key_path).await?;

        let snap = ConfigVersionSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            key_path: key_path.to_string(),
            version,
            snapshot_json: snapshot_json.clone(),
            checksum,
            created_at: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        };
        self.storage.save_config_snapshot(&snap).await?;
        Ok(snap)
    }

    pub async fn get_snapshot(&self, key_path: &str, version: u64) -> Result<Option<ConfigVersionSnapshot>, String> {
        self.storage.load_config_snapshot(key_path, version).await
    }

    pub async fn list_versions(&self, key_path: &str) -> Result<Vec<ConfigVersionSnapshot>, String> {
        self.storage.list_config_snapshots(key_path).await
    }

    pub async fn rollback(
        &self,
        key_path: &str,
        version: u64,
        operator: &str,
        reason: &str,
    ) -> Result<ConfigTree, String> {
        let snap = self
            .get_snapshot(key_path, version)
            .await?
            .ok_or_else(|| format!("version {version} not found for key_path '{key_path}'"))?;

        let tree: ConfigTree =
            serde_json::from_value(snap.snapshot_json.clone()).map_err(|e| format!("deserialize config tree: {e}"))?;

        let current_json = serde_json::to_value(&tree).map_err(|e| format!("serialize current: {e}"))?;
        self.record_change(
            operator,
            &format!("rollback: {reason}"),
            key_path,
            serde_json::json!({ "rollback_to_version": version }),
            current_json,
        )
        .await?;

        Ok(tree)
    }
}

// ---------------------------------------------------------------------------
// 16.2 — Approval Workflow Integration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Draft,
    PendingApproval,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRecord {
    pub id: String,
    pub config_domain: String,
    pub change_description: String,
    pub status: ApprovalStatus,
    pub requester: String,
    pub reviewer: Option<String>,
    pub reviewed_at: Option<String>,
    pub webhook_url: Option<String>,
    pub draft_config_json: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

const SENSITIVE_DOMAINS: &[&str] = &["mapping_rules", "allow_destructive", "dangerous_ddl_policy"];

pub fn is_sensitive_domain(domain: &str) -> bool {
    SENSITIVE_DOMAINS.contains(&domain)
}

pub fn requires_approval_for_change(domain: &str, current_status: ApprovalStatus) -> bool {
    if !is_sensitive_domain(domain) {
        return false;
    }
    matches!(current_status, ApprovalStatus::Draft | ApprovalStatus::Rejected)
}

pub struct ConfigApproval {
    storage: Arc<Storage>,
}

impl ConfigApproval {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }

    pub async fn submit_change(
        &self,
        domain: &str,
        description: &str,
        requester: &str,
        draft_config: serde_json::Value,
        webhook_url: Option<&str>,
    ) -> Result<ApprovalRecord, String> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let record = ApprovalRecord {
            id: uuid::Uuid::new_v4().to_string(),
            config_domain: domain.to_string(),
            change_description: description.to_string(),
            status: if is_sensitive_domain(domain) {
                ApprovalStatus::PendingApproval
            } else {
                ApprovalStatus::Approved
            },
            requester: requester.to_string(),
            reviewer: None,
            reviewed_at: None,
            webhook_url: webhook_url.map(String::from),
            draft_config_json: draft_config,
            created_at: now.clone(),
            updated_at: now,
        };
        self.storage.save_approval_record(&record).await?;
        Ok(record)
    }

    pub async fn approve(&self, id: &str, reviewer: &str) -> Result<ApprovalRecord, String> {
        let mut record =
            self.storage.load_approval_record(id).await?.ok_or_else(|| format!("approval record {id} not found"))?;
        if record.status != ApprovalStatus::PendingApproval {
            return Err(format!("record {id} is not in PendingApproval state (current: {:?})", record.status));
        }
        record.status = ApprovalStatus::Approved;
        record.reviewer = Some(reviewer.to_string());
        record.reviewed_at = Some(Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        record.updated_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        self.storage.save_approval_record(&record).await?;
        Ok(record)
    }

    pub async fn reject(&self, id: &str, reviewer: &str) -> Result<ApprovalRecord, String> {
        let mut record =
            self.storage.load_approval_record(id).await?.ok_or_else(|| format!("approval record {id} not found"))?;
        if record.status != ApprovalStatus::PendingApproval {
            return Err(format!("record {id} is not in PendingApproval state"));
        }
        record.status = ApprovalStatus::Rejected;
        record.reviewer = Some(reviewer.to_string());
        record.reviewed_at = Some(Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        record.updated_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        self.storage.save_approval_record(&record).await?;
        Ok(record)
    }

    pub async fn list_pending(&self) -> Result<Vec<ApprovalRecord>, String> {
        self.storage.query_approval_records(Some(ApprovalStatus::PendingApproval)).await
    }

    pub async fn check_effective(&self, domain: &str) -> Result<bool, String> {
        if !is_sensitive_domain(domain) {
            return Ok(true);
        }
        let records = self.storage.query_approval_records_by_domain(domain).await?;
        let latest = records.into_iter().last();
        match latest {
            Some(r) => Ok(r.status == ApprovalStatus::Approved),
            None => Ok(false),
        }
    }
}

// ---------------------------------------------------------------------------
// 16.3 — Cross-Environment Config Drift Detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigChecksum {
    pub env: String,
    pub key_path: String,
    pub checksum: String,
    pub computed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftReport {
    pub source_env: String,
    pub target_env: String,
    pub key_path: String,
    pub source_checksum: String,
    pub target_checksum: String,
    pub mismatched_fields: Vec<String>,
    pub source_changed_at: Option<String>,
    pub detected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftAlert {
    pub id: String,
    pub source_env: String,
    pub target_env: String,
    pub config_key: String,
    pub expected_checksum: String,
    pub actual_checksum: String,
    pub details_json: serde_json::Value,
    pub detected_at: String,
    pub acknowledged: bool,
}

pub fn compute_config_checksum(tree: &ConfigTree) -> String {
    let json = serde_json::to_vec(tree).unwrap_or_default();
    hex_encode(&Sha256::digest(&json))
}

pub fn compute_config_checksum_for_layer(tree: &ConfigTree, key_path: &str) -> Option<String> {
    let merged = tree.merge().ok()?;
    let relevant: HashMap<String, serde_json::Value> =
        merged.values.into_iter().filter(|(k, _)| k.starts_with(key_path)).collect();
    if relevant.is_empty() {
        return None;
    }
    let json = serde_json::to_vec(&relevant).ok()?;
    Some(hex_encode(&Sha256::digest(&json)))
}

pub fn detect_drift(source: &ConfigTree, target: &ConfigTree, key_path: &str) -> Option<DriftReport> {
    let source_merged = source.merge().ok()?;
    let target_merged = target.merge().ok()?;

    let source_vals: HashMap<&String, &serde_json::Value> =
        source_merged.values.iter().filter(|(k, _)| k.starts_with(key_path)).collect();
    let target_vals: HashMap<&String, &serde_json::Value> =
        target_merged.values.iter().filter(|(k, _)| k.starts_with(key_path)).collect();

    let all_keys: std::collections::BTreeSet<&String> = source_vals.keys().chain(target_vals.keys()).copied().collect();

    let mismatched: Vec<String> = all_keys
        .into_iter()
        .filter(|k| match (source_vals.get(k), target_vals.get(k)) {
            (Some(sv), Some(tv)) => sv != tv,
            _ => true,
        })
        .map(|k| {
            let s = source_vals.get(k).map(|v| v.to_string()).unwrap_or_default();
            let t = target_vals.get(k).map(|v| v.to_string()).unwrap_or_default();
            format!("{k}: source={s}, target={t}")
        })
        .collect();

    if mismatched.is_empty() {
        return None;
    }

    let source_ck = compute_config_checksum_for_layer(source, key_path).unwrap_or_default();
    let target_ck = compute_config_checksum_for_layer(target, key_path).unwrap_or_default();

    Some(DriftReport {
        source_env: String::new(),
        target_env: String::new(),
        key_path: key_path.to_string(),
        source_checksum: source_ck,
        target_checksum: target_ck,
        mismatched_fields: mismatched,
        source_changed_at: None,
        detected_at: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
    })
}

pub struct DriftDetector {
    storage: Arc<Storage>,
}

impl DriftDetector {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }

    pub fn compare_envs(
        &self,
        source_env: &str,
        target_env: &str,
        source_tree: &ConfigTree,
        target_tree: &ConfigTree,
        key_path: &str,
    ) -> Option<DriftReport> {
        let mut report = detect_drift(source_tree, target_tree, key_path)?;
        report.source_env = source_env.to_string();
        report.target_env = target_env.to_string();
        Some(report)
    }

    pub async fn record_alert(&self, alert: &DriftAlert) -> Result<(), String> {
        self.storage.save_drift_alert(alert).await
    }

    pub async fn acknowledge_alert(&self, id: &str) -> Result<(), String> {
        self.storage.acknowledge_drift_alert(id).await
    }

    pub async fn list_alerts(&self, acknowledged: Option<bool>) -> Result<Vec<DriftAlert>, String> {
        self.storage.query_drift_alerts(acknowledged).await
    }
}

// ---------------------------------------------------------------------------
// 16.4 — COW Snapshot (ArcSwap-based hot-reload)
// ---------------------------------------------------------------------------

pub struct ConfigSnapshot {
    inner: ArcSwap<ConfigTree>,
    key_path: String,
    auditor: Arc<ConfigAuditor>,
}

impl ConfigSnapshot {
    pub fn new(tree: ConfigTree, key_path: &str, auditor: Arc<ConfigAuditor>) -> Self {
        Self { inner: ArcSwap::new(Arc::new(tree)), key_path: key_path.to_string(), auditor }
    }

    pub fn load(&self) -> Arc<ConfigTree> {
        self.inner.load_full()
    }

    pub fn apply(
        &self,
        operator: &str,
        reason: &str,
        f: impl FnOnce(&mut ConfigTree),
    ) -> Result<Arc<ConfigTree>, String>
    where
        Self: Sized,
    {
        let prev = self.inner.load_full();
        let mut new_tree = (*prev).clone();
        f(&mut new_tree);

        let prev_json = serde_json::to_value(&*prev).map_err(|e| format!("serialize prev: {e}"))?;
        let new_json = serde_json::to_value(&new_tree).map_err(|e| format!("serialize new: {e}"))?;

        let diff = serde_json::json!({
            "prev": prev_json,
            "new": new_json,
        });

        let new_arc = Arc::new(new_tree);
        self.inner.store(new_arc.clone());

        let auditor = self.auditor.clone();
        let key_path = self.key_path.clone();
        let operator = operator.to_string();
        let reason = reason.to_string();
        tokio::spawn(async move {
            let _ = auditor.record_change(&operator, &reason, &key_path, diff, new_json).await;
        });

        Ok(new_arc)
    }

    pub fn apply_silent(&self, f: impl FnOnce(&mut ConfigTree)) -> Arc<ConfigTree> {
        let prev = self.inner.load_full();
        let mut new_tree = (*prev).clone();
        f(&mut new_tree);
        let new_arc = Arc::new(new_tree);
        self.inner.store(new_arc.clone());
        new_arc
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::layer::ConfigLayer;
    use std::sync::Arc;

    async fn make_test_storage() -> Arc<Storage> {
        let tmp = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&tmp).unwrap();
        let db_path = tmp.join("test_governance.db");
        let storage = Arc::new(Storage::open(&db_path).await.unwrap());
        std::mem::forget(tmp);
        storage
    }

    fn make_test_tree() -> ConfigTree {
        let mut tree = ConfigTree::new();
        tree.add_layer(LayerConfig {
            layer: ConfigLayer::Global,
            name: "test".to_string(),
            values: HashMap::from([
                ("host".to_string(), serde_json::Value::String("db.example.com".to_string())),
                ("port".to_string(), serde_json::json!(5432)),
            ]),
            enabled: true,
            ..Default::default()
        });
        tree
    }

    // ---- 16.1 Audit Tests ----

    #[tokio::test]
    async fn test_audit_record_and_query() {
        let storage = make_test_storage().await;
        let auditor = ConfigAuditor::new(storage.clone());

        auditor
            .record_change(
                "alice",
                "update host",
                "database.host",
                serde_json::json!({"old": "old.host.com", "new": "new.host.com"}),
                serde_json::json!({"host": "new.host.com"}),
            )
            .await
            .unwrap();

        let summary = auditor
            .query_history(&AuditQuery { key_path: None, operator: None, limit: None, offset: None })
            .await
            .unwrap();
        assert_eq!(summary.total_entries, 1);
        assert_eq!(summary.entries[0].operator, "alice");
        assert_eq!(summary.entries[0].key_path, "database.host");

        let filtered = auditor
            .query_history(&AuditQuery {
                key_path: Some("database.host".into()),
                operator: Some("alice".into()),
                limit: Some(10),
                offset: Some(0),
            })
            .await
            .unwrap();
        assert_eq!(filtered.total_entries, 1);

        let empty = auditor
            .query_history(&AuditQuery {
                key_path: Some("other.key".into()),
                operator: None,
                limit: None,
                offset: None,
            })
            .await
            .unwrap();
        assert_eq!(empty.total_entries, 0);
    }

    #[tokio::test]
    async fn test_audit_multiple_entries() {
        let storage = make_test_storage().await;
        let auditor = ConfigAuditor::new(storage.clone());

        for i in 0..3 {
            auditor
                .record_change(
                    &format!("user{i}"),
                    &format!("change {i}"),
                    "app.config",
                    serde_json::json!({"index": i}),
                    serde_json::json!({"version": i}),
                )
                .await
                .unwrap();
        }

        let summary = auditor
            .query_history(&AuditQuery { key_path: None, operator: None, limit: Some(2), offset: None })
            .await
            .unwrap();
        assert_eq!(summary.total_entries, 3);
        assert_eq!(summary.entries.len(), 2);
    }

    // ---- 16.1 Snapshot Tests ----

    #[tokio::test]
    async fn test_snapshot_save_and_rollback() {
        let storage = make_test_storage().await;
        let auditor = ConfigAuditor::new(storage.clone());
        let tree = make_test_tree();

        let snap = auditor.save_snapshot("app.config", &tree).await.unwrap();
        assert_eq!(snap.version, 1);
        assert!(!snap.checksum.is_empty());

        let loaded = auditor.get_snapshot("app.config", 1).await.unwrap().unwrap();
        assert_eq!(loaded.checksum, snap.checksum);

        let versions = auditor.list_versions("app.config").await.unwrap();
        assert_eq!(versions.len(), 1);
    }

    #[tokio::test]
    async fn test_snapshot_version_increment() {
        let storage = make_test_storage().await;
        let auditor = ConfigAuditor::new(storage.clone());

        let tree = make_test_tree();
        let v1 = auditor.save_snapshot("app.config", &tree).await.unwrap();
        assert_eq!(v1.version, 1);

        let v2 = auditor.save_snapshot("app.config", &tree).await.unwrap();
        assert_eq!(v2.version, 2);

        let versions = auditor.list_versions("app.config").await.unwrap();
        assert_eq!(versions.len(), 2);
    }

    #[tokio::test]
    async fn test_rollback_restores_snapshot() {
        let storage = make_test_storage().await;
        let auditor = ConfigAuditor::new(storage.clone());

        let mut tree = make_test_tree();
        let snap1 = auditor.save_snapshot("app.config", &tree).await.unwrap();

        tree.add_layer(LayerConfig {
            layer: ConfigLayer::Task,
            name: "override".to_string(),
            values: HashMap::from([("host".to_string(), serde_json::Value::String("override.host.com".to_string()))]),
            enabled: true,
            ..Default::default()
        });
        auditor.save_snapshot("app.config", &tree).await.unwrap();

        let rolled = auditor.rollback("app.config", 1, "bob", "bad override").await.unwrap();
        let merged = rolled.merge().unwrap();
        assert_eq!(merged.values.get("host").unwrap(), &serde_json::Value::String("db.example.com".to_string()));

        let history = auditor
            .query_history(&AuditQuery {
                key_path: Some("app.config".into()),
                operator: None,
                limit: None,
                offset: None,
            })
            .await
            .unwrap();
        let rollback_entries: Vec<_> = history.entries.iter().filter(|e| e.reason.contains("rollback")).collect();
        assert_eq!(rollback_entries.len(), 1);
    }

    #[tokio::test]
    async fn test_rollback_nonexistent_version() {
        let storage = make_test_storage().await;
        let auditor = ConfigAuditor::new(storage.clone());
        let result = auditor.rollback("app.config", 99, "alice", "test").await;
        assert!(result.is_err());
    }

    // ---- 16.2 Approval Tests ----

    #[test]
    fn test_sensitive_domain_check() {
        assert!(is_sensitive_domain("mapping_rules"));
        assert!(is_sensitive_domain("allow_destructive"));
        assert!(is_sensitive_domain("dangerous_ddl_policy"));
        assert!(!is_sensitive_domain("theme"));
        assert!(!is_sensitive_domain("log_level"));
    }

    #[test]
    fn test_requires_approval_logic() {
        assert!(requires_approval_for_change("mapping_rules", ApprovalStatus::Draft));
        assert!(requires_approval_for_change("allow_destructive", ApprovalStatus::Rejected));
        assert!(!requires_approval_for_change("allow_destructive", ApprovalStatus::Approved));
        assert!(!requires_approval_for_change("theme", ApprovalStatus::Draft));
    }

    #[tokio::test]
    async fn test_submit_change_sensitive_domain() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        let record = approval
            .submit_change(
                "allow_destructive",
                "enable drop table",
                "alice",
                serde_json::json!({"enabled": true}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(record.status, ApprovalStatus::PendingApproval);
        assert_eq!(record.requester, "alice");
    }

    #[tokio::test]
    async fn test_submit_change_non_sensitive_domain() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        let record = approval
            .submit_change("theme", "set dark mode", "alice", serde_json::json!({"theme": "dark"}), None)
            .await
            .unwrap();
        assert_eq!(record.status, ApprovalStatus::Approved);
    }

    #[tokio::test]
    async fn test_approve_workflow() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        let record = approval
            .submit_change(
                "mapping_rules",
                "add mysql mapping",
                "alice",
                serde_json::json!({"rule": "varchar->text"}),
                None,
            )
            .await
            .unwrap();

        let approved = approval.approve(&record.id, "bob").await.unwrap();
        assert_eq!(approved.status, ApprovalStatus::Approved);
        assert_eq!(approved.reviewer.as_deref(), Some("bob"));
    }

    #[tokio::test]
    async fn test_reject_workflow() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        let record = approval
            .submit_change(
                "dangerous_ddl_policy",
                "allow drop database",
                "alice",
                serde_json::json!({"allow": true}),
                None,
            )
            .await
            .unwrap();

        let rejected = approval.reject(&record.id, "bob").await.unwrap();
        assert_eq!(rejected.status, ApprovalStatus::Rejected);
    }

    #[tokio::test]
    async fn test_approve_invalid_state() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        let record = approval
            .submit_change("theme", "dark mode", "alice", serde_json::json!({"theme": "dark"}), None)
            .await
            .unwrap();
        assert!(record.status == ApprovalStatus::Approved);

        let result = approval.approve(&record.id, "bob").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_check_effective() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        assert!(!approval.check_effective("allow_destructive").await.unwrap());

        let record = approval
            .submit_change("allow_destructive", "enable", "alice", serde_json::json!({"enabled": true}), None)
            .await
            .unwrap();
        assert!(!approval.check_effective("allow_destructive").await.unwrap());

        approval.approve(&record.id, "bob").await.unwrap();
        assert!(approval.check_effective("allow_destructive").await.unwrap());

        assert!(approval.check_effective("theme").await.unwrap());
    }

    #[tokio::test]
    async fn test_list_pending() {
        let storage = make_test_storage().await;
        let approval = ConfigApproval::new(storage.clone());

        approval.submit_change("mapping_rules", "rule1", "alice", serde_json::json!({"r": 1}), None).await.unwrap();
        approval.submit_change("allow_destructive", "rule2", "bob", serde_json::json!({"r": 2}), None).await.unwrap();

        let pending = approval.list_pending().await.unwrap();
        assert_eq!(pending.len(), 2);
    }

    // ---- 16.3 Drift Detection Tests ----

    #[test]
    fn test_checksum_computation() {
        let tree = make_test_tree();
        let ck = compute_config_checksum(&tree);
        assert_eq!(ck.len(), 64);
        assert!(ck.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_checksum_deterministic() {
        let tree = make_test_tree();
        let ck1 = compute_config_checksum(&tree);
        let ck2 = compute_config_checksum(&tree);
        assert_eq!(ck1, ck2);
    }

    #[test]
    fn test_checksum_differs_on_change() {
        let mut tree1 = make_test_tree();
        let mut tree2 = make_test_tree();
        tree2.add_layer(LayerConfig {
            layer: ConfigLayer::Task,
            name: "override".to_string(),
            values: HashMap::from([("host".to_string(), serde_json::Value::String("other.com".to_string()))]),
            enabled: true,
            ..Default::default()
        });
        assert_ne!(compute_config_checksum(&tree1), compute_config_checksum(&tree2));
    }

    #[test]
    fn test_layer_checksum() {
        let tree = make_test_tree();
        let ck = compute_config_checksum_for_layer(&tree, "host").unwrap();
        assert_eq!(ck.len(), 64);

        let none = compute_config_checksum_for_layer(&tree, "nonexistent");
        assert!(none.is_none());
    }

    #[test]
    fn test_detect_drift_no_drift() {
        let tree1 = make_test_tree();
        let tree2 = make_test_tree();
        assert!(detect_drift(&tree1, &tree2, "host").is_none());
    }

    #[test]
    fn test_detect_drift_with_drift() {
        let tree1 = make_test_tree();
        let mut tree2 = make_test_tree();
        tree2.add_layer(LayerConfig {
            layer: ConfigLayer::Task,
            name: "override".to_string(),
            values: HashMap::from([("host".to_string(), serde_json::Value::String("other.com".to_string()))]),
            enabled: true,
            ..Default::default()
        });

        let report = detect_drift(&tree1, &tree2, "host").unwrap();
        assert_eq!(report.key_path, "host");
        assert!(!report.mismatched_fields.is_empty());
    }

    #[test]
    fn test_detect_drift_partial_keys() {
        let tree1 = make_test_tree();
        let tree2 = make_test_tree();
        let report = detect_drift(&tree1, &tree2, "port");
        assert!(report.is_none());
    }

    #[tokio::test]
    async fn test_drift_alert_persistence() {
        let storage = make_test_storage().await;
        let detector = DriftDetector::new(storage.clone());

        let alert = DriftAlert {
            id: uuid::Uuid::new_v4().to_string(),
            source_env: "prod".to_string(),
            target_env: "staging".to_string(),
            config_key: "database.host".to_string(),
            expected_checksum: "abc".to_string(),
            actual_checksum: "def".to_string(),
            details_json: serde_json::json!({"field": "host", "expected": "prod-host", "actual": "staging-host"}),
            detected_at: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            acknowledged: false,
        };
        detector.record_alert(&alert).await.unwrap();

        let unacked = detector.list_alerts(Some(false)).await.unwrap();
        assert_eq!(unacked.len(), 1);

        detector.acknowledge_alert(&alert.id).await.unwrap();
        let still_unacked = detector.list_alerts(Some(false)).await.unwrap();
        assert_eq!(still_unacked.len(), 0);
        let acked = detector.list_alerts(Some(true)).await.unwrap();
        assert_eq!(acked.len(), 1);
    }

    // ---- 16.4 COW Snapshot Tests ----

    #[test]
    fn test_config_snapshot_load() {
        let storage = make_test_storage_for_snapshot();
        let auditor = Arc::new(ConfigAuditor::new(storage));
        let tree = make_test_tree();
        let snapshot = ConfigSnapshot::new(tree, "app.config", auditor);

        let loaded = snapshot.load();
        let merged = loaded.merge().unwrap();
        assert_eq!(merged.values.get("host").unwrap(), &serde_json::Value::String("db.example.com".to_string()));
    }

    #[tokio::test]
    async fn test_config_snapshot_apply_modification() {
        let storage = make_test_storage().await;
        let auditor = Arc::new(ConfigAuditor::new(storage));
        let tree = make_test_tree();
        let snapshot = ConfigSnapshot::new(tree, "app.config", auditor);

        snapshot
            .apply("alice", "update port", |t| {
                for layer in &mut t.layers {
                    if layer.name == "test" {
                        layer.values.insert("port".to_string(), serde_json::json!(3306));
                    }
                }
            })
            .unwrap();

        let loaded = snapshot.load();
        let merged = loaded.merge().unwrap();
        assert_eq!(merged.values.get("port").unwrap(), &serde_json::json!(3306));
    }

    #[test]
    fn test_config_snapshot_apply_silent_no_audit() {
        let storage = make_test_storage_for_snapshot();
        let auditor = Arc::new(ConfigAuditor::new(storage.clone()));
        let tree = make_test_tree();
        let snapshot = ConfigSnapshot::new(tree, "app.config", auditor);

        snapshot.apply_silent(|t| {
            for layer in &mut t.layers {
                if layer.name == "test" {
                    layer.values.insert("host".to_string(), serde_json::Value::String("silent.host.com".to_string()));
                }
            }
        });

        let loaded = snapshot.load();
        let merged = loaded.merge().unwrap();
        assert_eq!(merged.values.get("host").unwrap(), &serde_json::Value::String("silent.host.com".to_string()));
    }

    #[test]
    fn test_config_snapshot_concurrent_reads() {
        use std::thread;
        let storage = make_test_storage_for_snapshot();
        let auditor = Arc::new(ConfigAuditor::new(storage));
        let tree = make_test_tree();
        let snapshot = Arc::new(ConfigSnapshot::new(tree, "app.config", auditor));

        let mut handles = Vec::new();
        for i in 0..10 {
            let snap = snapshot.clone();
            handles.push(thread::spawn(move || {
                let loaded = snap.load();
                let merged = loaded.merge().unwrap();
                let port = merged.values.get("port").and_then(|v| v.as_i64()).unwrap_or(0);
                assert_eq!(port, 5432);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
    }

    fn make_test_storage_for_snapshot() -> Arc<Storage> {
        let tmp = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&tmp).unwrap();
        let db_path = tmp.join("test_snapshot.db");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let storage = Arc::new(rt.block_on(Storage::open(&db_path)).unwrap());
        std::mem::forget(tmp);
        storage
    }
}
