use std::collections::HashMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::schema_diff::normalize_definition;

// ============================================================================
// 6.1: State Data Structures
// ============================================================================

const DRIFT_NONE: f64 = 0.0;
const DRIFT_NEW_OBJECT: f64 = 0.3;
const DRIFT_SINGLE_SIDE: f64 = 0.33;
const DRIFT_IDENTICAL_CHANGE: f64 = 0.5;
const DRIFT_DELETED: f64 = 0.66;
const DRIFT_STALE_BASELINE: f64 = 0.8;
const DRIFT_CONFLICT: f64 = 1.0;
const DRIFT_PSEUDO: f64 = 0.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticFingerprint {
    pub fingerprint: String,
    pub object_fingerprints: HashMap<String, String>,
}

impl SemanticFingerprint {
    pub fn compute(objects: &[ObjectDefinition]) -> Self {
        let mut object_fingerprints = HashMap::new();
        for obj in objects {
            let normalized = normalize_definition(&obj.definition);
            let hash = hex(Sha256::digest(normalized.as_bytes()));
            object_fingerprints.insert(obj.key(), hash);
        }

        let mut all_keys: Vec<&String> = object_fingerprints.keys().collect();
        all_keys.sort();
        let mut hasher = Sha256::new();
        for key in all_keys {
            hasher.update(key.as_bytes());
            hasher.update(b":");
            hasher.update(object_fingerprints[key].as_bytes());
            hasher.update(b";");
        }
        let fingerprint = hex(hasher.finalize());

        Self { fingerprint, object_fingerprints }
    }

    pub fn object_fingerprint(def: &str) -> String {
        let normalized = normalize_definition(def);
        hex(Sha256::digest(normalized.as_bytes()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDefinition {
    pub kind: ObjectKind,
    pub name: String,
    pub schema: Option<String>,
    pub definition: String,
}

impl ObjectDefinition {
    pub fn key(&self) -> String {
        match &self.schema {
            Some(schema) => format!("{}.{}.{}", self.kind.as_str(), schema, self.name),
            None => format!("{}.{}", self.kind.as_str(), self.name),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Table,
    View,
    Function,
    Sequence,
    Rule,
    Permission,
}

impl ObjectKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::View => "view",
            Self::Function => "function",
            Self::Sequence => "sequence",
            Self::Rule => "rule",
            Self::Permission => "permission",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub id: String,
    pub timestamp: String,
    pub label: String,
    pub objects: Vec<ObjectDefinition>,
    pub fingerprint: SemanticFingerprint,
}

impl StateSnapshot {
    pub fn new(label: &str, objects: Vec<ObjectDefinition>) -> Self {
        let fingerprint = SemanticFingerprint::compute(&objects);
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            label: label.to_string(),
            objects,
            fingerprint,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObjectReconciliationStatus {
    Synced,
    SourceDrifted,
    TargetDrifted,
    BothDriftedIdentical,
    BothDriftedConflict,
    DeletedInSource,
    DeletedInTarget,
    NewInSource,
    NewInTarget,
    NewInBoth,
    BaselineOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectReconciliation {
    pub object_key: String,
    pub kind: ObjectKind,
    pub name: String,
    pub status: ObjectReconciliationStatus,
    pub baseline_fingerprint: Option<String>,
    pub source_fingerprint: Option<String>,
    pub target_fingerprint: Option<String>,
    pub source_definition: Option<String>,
    pub target_definition: Option<String>,
    pub drift_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationResult {
    pub baseline_id: String,
    pub source_id: String,
    pub target_id: String,
    pub timestamp: String,
    pub total_objects: usize,
    pub synced_count: usize,
    pub drifted_count: usize,
    pub conflict_count: usize,
    pub object_reconciliations: Vec<ObjectReconciliation>,
}

pub fn reconcile_three_way(
    baseline: &StateSnapshot,
    source_id: &str,
    source: &[ObjectDefinition],
    target_id: &str,
    target: &[ObjectDefinition],
) -> ReconciliationResult {
    let baseline_map: HashMap<String, &ObjectDefinition> = baseline.objects.iter().map(|o| (o.key(), o)).collect();
    let source_map: HashMap<String, &ObjectDefinition> = source.iter().map(|o| (o.key(), o)).collect();
    let target_map: HashMap<String, &ObjectDefinition> = target.iter().map(|o| (o.key(), o)).collect();

    let all_keys: Vec<String> = {
        let mut keys: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for map in [&baseline_map, &source_map, &target_map] {
            for key in map.keys() {
                if seen.insert(key.clone()) {
                    keys.push(key.clone());
                }
            }
        }
        keys.sort();
        keys
    };

    let mut object_reconciliations = Vec::new();
    let mut synced = 0;
    let mut drifted = 0;
    let mut conflicts = 0;

    for key in &all_keys {
        let b_obj = baseline_map.get(key);
        let s_obj = source_map.get(key);
        let t_obj = target_map.get(key);

        let b_fp = b_obj.map(|o| SemanticFingerprint::object_fingerprint(&o.definition));
        let s_fp = s_obj.map(|o| SemanticFingerprint::object_fingerprint(&o.definition));
        let t_fp = t_obj.map(|o| SemanticFingerprint::object_fingerprint(&o.definition));

        let (status, drift_score) = classify_reconciliation(&b_fp, &s_fp, &t_fp);

        match status {
            ObjectReconciliationStatus::Synced | ObjectReconciliationStatus::NewInBoth => synced += 1,
            ObjectReconciliationStatus::BothDriftedConflict => {
                drifted += 1;
                conflicts += 1;
            }
            _ => drifted += 1,
        }

        let kind = b_obj.or(s_obj).or(t_obj).map(|o| o.kind.clone()).unwrap_or(ObjectKind::Table);

        let name = b_obj.or(s_obj).or(t_obj).map(|o| o.name.clone()).unwrap_or_default();

        object_reconciliations.push(ObjectReconciliation {
            object_key: key.clone(),
            kind,
            name,
            status,
            baseline_fingerprint: b_fp,
            source_fingerprint: s_fp,
            target_fingerprint: t_fp,
            source_definition: s_obj.map(|o| o.definition.clone()),
            target_definition: t_obj.map(|o| o.definition.clone()),
            drift_score,
        });
    }

    ReconciliationResult {
        baseline_id: baseline.id.clone(),
        source_id: source_id.to_string(),
        target_id: target_id.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        total_objects: all_keys.len(),
        synced_count: synced,
        drifted_count: drifted,
        conflict_count: conflicts,
        object_reconciliations,
    }
}

fn classify_reconciliation(
    b_fp: &Option<String>,
    s_fp: &Option<String>,
    t_fp: &Option<String>,
) -> (ObjectReconciliationStatus, f64) {
    match (b_fp, s_fp, t_fp) {
        // All present
        (Some(b), Some(s), Some(t)) => {
            if b == s && s == t {
                (ObjectReconciliationStatus::Synced, DRIFT_NONE)
            } else if b == s && s != t {
                (ObjectReconciliationStatus::TargetDrifted, DRIFT_SINGLE_SIDE)
            } else if b == t && s != t {
                (ObjectReconciliationStatus::SourceDrifted, DRIFT_SINGLE_SIDE)
            } else if s == t && b != s {
                (ObjectReconciliationStatus::BothDriftedIdentical, DRIFT_IDENTICAL_CHANGE)
            } else {
                (ObjectReconciliationStatus::BothDriftedConflict, DRIFT_CONFLICT)
            }
        }
        // Baseline present, others may be absent
        (Some(_), None, Some(_)) => (ObjectReconciliationStatus::DeletedInSource, DRIFT_DELETED),
        (Some(_), Some(_), None) => (ObjectReconciliationStatus::DeletedInTarget, DRIFT_DELETED),
        (Some(_), None, None) => (ObjectReconciliationStatus::BaselineOnly, DRIFT_STALE_BASELINE),
        // Baseline absent, one or both present
        (None, Some(s), Some(t)) => {
            if s == t {
                (ObjectReconciliationStatus::NewInBoth, DRIFT_NONE)
            } else {
                (ObjectReconciliationStatus::BothDriftedConflict, DRIFT_CONFLICT)
            }
        }
        (None, Some(_), None) => (ObjectReconciliationStatus::NewInSource, DRIFT_NONE),
        (None, None, Some(_)) => (ObjectReconciliationStatus::NewInTarget, DRIFT_NONE),
        (None, None, None) => (ObjectReconciliationStatus::Synced, DRIFT_NONE),
    }
}

// ============================================================================
// 6.2: Semantic Fingerprints — Drift Detection & Scoring
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub has_drift: bool,
    pub drifted_objects: Vec<DriftedObject>,
    pub pseudo_drift_count: usize,
    pub real_drift_count: usize,
    pub overall_drift_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftedObject {
    pub object_key: String,
    pub baseline_fingerprint: String,
    pub current_fingerprint: String,
    pub is_pseudo_drift: bool,
    pub score: f64,
}

pub fn detect_drift(baseline: &StateSnapshot, current: &[ObjectDefinition]) -> DriftReport {
    let current_fp = SemanticFingerprint::compute(current);
    let overall_has_drift = baseline.fingerprint.fingerprint != current_fp.fingerprint;

    let current_map: HashMap<String, &ObjectDefinition> = current.iter().map(|o| (o.key(), o)).collect();

    let mut drifted_objects = Vec::new();
    let mut pseudo = 0;
    let mut real = 0;

    for obj in &baseline.objects {
        let b_fp = baseline.fingerprint.object_fingerprints.get(&obj.key()).cloned().unwrap_or_default();
        let c_fp = current_fp.object_fingerprints.get(&obj.key()).cloned().unwrap_or_default();

        if b_fp != c_fp {
            let is_pseudo =
                filter_pseudo_drift(&obj.definition, current_map.get(&obj.key()).map(|o| o.definition.as_str()));
            if is_pseudo {
                pseudo += 1;
            } else {
                real += 1;
            }
            drifted_objects.push(DriftedObject {
                object_key: obj.key(),
                baseline_fingerprint: b_fp,
                current_fingerprint: c_fp,
                is_pseudo_drift: is_pseudo,
                score: if is_pseudo { DRIFT_PSEUDO } else { DRIFT_IDENTICAL_CHANGE },
            });
        }
    }

    // Check for new objects in current
    for obj in current {
        if !baseline.fingerprint.object_fingerprints.contains_key(&obj.key()) {
            real += 1;
            drifted_objects.push(DriftedObject {
                object_key: obj.key(),
                baseline_fingerprint: String::new(),
                current_fingerprint: current_fp.object_fingerprints.get(&obj.key()).cloned().unwrap_or_default(),
                is_pseudo_drift: false,
                score: DRIFT_NEW_OBJECT,
            });
        }
    }

    let total = drifted_objects.len();
    let overall_drift_score =
        if total == 0 { 0.0 } else { drifted_objects.iter().map(|d| d.score).sum::<f64>() / total as f64 };

    DriftReport {
        has_drift: overall_has_drift || !drifted_objects.is_empty(),
        drifted_objects,
        pseudo_drift_count: pseudo,
        real_drift_count: real,
        overall_drift_score,
    }
}

fn filter_pseudo_drift(baseline_def: &str, current_def: Option<&str>) -> bool {
    let Some(cur_def) = current_def else {
        return false;
    };

    let b_norm = normalize_definition(baseline_def);
    let c_norm = normalize_definition(cur_def);

    // Pseudo-drift: normalized forms are equal (whitespace-only changes)
    if b_norm == c_norm {
        return true;
    }

    // Pseudo-drift: only comment lines changed
    let b_no_comments = strip_sql_comments(&b_norm);
    let c_no_comments = strip_sql_comments(&c_norm);
    if b_no_comments == c_no_comments {
        return true;
    }

    false
}

fn strip_sql_comments(sql: &str) -> String {
    sql.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with("--") || trimmed.starts_with("//") || trimmed.starts_with('#'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn hex(data: sha2::digest::Output<Sha256>) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

// ============================================================================
// 6.3: Smart Baseline Reset
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RebaseResolution {
    AcceptSource,
    AcceptTarget,
    AcceptBaseline,
    ManualReview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictItem {
    pub object_key: String,
    pub resolution: RebaseResolution,
    pub baseline_fingerprint: Option<String>,
    pub source_fingerprint: Option<String>,
    pub target_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    pub conflicts: Vec<ConflictItem>,
    pub proposed_objects: Vec<ObjectDefinition>,
    pub requires_manual_review: bool,
}

pub fn build_rebase_plan(
    baseline: &StateSnapshot,
    source: &[ObjectDefinition],
    target: &[ObjectDefinition],
    auto_resolve: bool,
) -> RebasePlan {
    let result = reconcile_three_way(baseline, "", source, "", target);
    let mut conflicts = Vec::new();
    let mut proposed_objects: Vec<ObjectDefinition> = Vec::new();
    let mut requires_manual = false;

    let source_map: HashMap<String, &ObjectDefinition> = source.iter().map(|o| (o.key(), o)).collect();
    let target_map: HashMap<String, &ObjectDefinition> = target.iter().map(|o| (o.key(), o)).collect();

    for rec in &result.object_reconciliations {
        match rec.status {
            ObjectReconciliationStatus::Synced | ObjectReconciliationStatus::BothDriftedIdentical => {
                if let Some(obj) = source_map.get(&rec.object_key).or_else(|| target_map.get(&rec.object_key)) {
                    proposed_objects.push((*obj).clone());
                }
            }
            ObjectReconciliationStatus::TargetDrifted => {
                if auto_resolve {
                    if let Some(obj) = target_map.get(&rec.object_key) {
                        proposed_objects.push((*obj).clone());
                    }
                    conflicts.push(ConflictItem {
                        object_key: rec.object_key.clone(),
                        resolution: RebaseResolution::AcceptTarget,
                        baseline_fingerprint: rec.baseline_fingerprint.clone(),
                        source_fingerprint: rec.source_fingerprint.clone(),
                        target_fingerprint: rec.target_fingerprint.clone(),
                    });
                } else {
                    requires_manual = true;
                    conflicts.push(ConflictItem {
                        object_key: rec.object_key.clone(),
                        resolution: RebaseResolution::ManualReview,
                        baseline_fingerprint: rec.baseline_fingerprint.clone(),
                        source_fingerprint: rec.source_fingerprint.clone(),
                        target_fingerprint: rec.target_fingerprint.clone(),
                    });
                }
            }
            ObjectReconciliationStatus::SourceDrifted => {
                if auto_resolve {
                    if let Some(obj) = source_map.get(&rec.object_key) {
                        proposed_objects.push((*obj).clone());
                    }
                    conflicts.push(ConflictItem {
                        object_key: rec.object_key.clone(),
                        resolution: RebaseResolution::AcceptSource,
                        baseline_fingerprint: rec.baseline_fingerprint.clone(),
                        source_fingerprint: rec.source_fingerprint.clone(),
                        target_fingerprint: rec.target_fingerprint.clone(),
                    });
                } else {
                    requires_manual = true;
                    conflicts.push(ConflictItem {
                        object_key: rec.object_key.clone(),
                        resolution: RebaseResolution::ManualReview,
                        baseline_fingerprint: rec.baseline_fingerprint.clone(),
                        source_fingerprint: rec.source_fingerprint.clone(),
                        target_fingerprint: rec.target_fingerprint.clone(),
                    });
                }
            }
            ObjectReconciliationStatus::BothDriftedConflict => {
                requires_manual = true;
                conflicts.push(ConflictItem {
                    object_key: rec.object_key.clone(),
                    resolution: RebaseResolution::ManualReview,
                    baseline_fingerprint: rec.baseline_fingerprint.clone(),
                    source_fingerprint: rec.source_fingerprint.clone(),
                    target_fingerprint: rec.target_fingerprint.clone(),
                });
            }
            ObjectReconciliationStatus::NewInBoth | ObjectReconciliationStatus::NewInSource => {
                if let Some(obj) = source_map.get(&rec.object_key) {
                    proposed_objects.push((*obj).clone());
                }
            }
            ObjectReconciliationStatus::NewInTarget => {
                if let Some(obj) = target_map.get(&rec.object_key) {
                    proposed_objects.push((*obj).clone());
                }
            }
            ObjectReconciliationStatus::DeletedInSource | ObjectReconciliationStatus::DeletedInTarget => {
                // Object is deleted in at least one source, don't include it
            }
            ObjectReconciliationStatus::BaselineOnly => {
                // Only in baseline, not in source or target — drop it
            }
        }
    }

    RebasePlan { conflicts, proposed_objects, requires_manual_review: requires_manual }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseHistoryEntry {
    pub id: String,
    pub timestamp: String,
    pub previous_baseline_id: String,
    pub new_baseline_id: String,
    pub object_count: usize,
    pub conflict_count: usize,
    pub auto_resolved: bool,
    pub notes: String,
}

impl RebaseHistoryEntry {
    pub fn new(
        previous_baseline_id: &str,
        new_baseline_id: &str,
        object_count: usize,
        conflict_count: usize,
        auto_resolved: bool,
        notes: &str,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            previous_baseline_id: previous_baseline_id.to_string(),
            new_baseline_id: new_baseline_id.to_string(),
            object_count,
            conflict_count,
            auto_resolved,
            notes: notes.to_string(),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_obj(kind: ObjectKind, name: &str, definition: &str) -> ObjectDefinition {
        ObjectDefinition { kind, name: name.to_string(), schema: None, definition: definition.to_string() }
    }

    fn make_table(name: &str, def: &str) -> ObjectDefinition {
        make_obj(ObjectKind::Table, name, def)
    }

    // --- 6.4: Three-way merge 9 combinations ---

    #[test]
    fn test_twm_all_synced() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let source = objs.clone();
        let target = objs.clone();
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.synced_count, 1);
        assert_eq!(result.drifted_count, 0);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::Synced);
    }

    #[test]
    fn test_twm_target_drifted() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let source = objs.clone();
        let target = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.drifted_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::TargetDrifted);
    }

    #[test]
    fn test_twm_source_drifted() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let source = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let target = objs.clone();
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.drifted_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::SourceDrifted);
    }

    #[test]
    fn test_twm_both_drifted_identical() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs);
        let source = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let target = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.drifted_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::BothDriftedIdentical);
    }

    #[test]
    fn test_twm_both_drifted_conflict() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs);
        let source = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let target = vec![make_table("t1", "CREATE TABLE t1 (name TEXT)")];
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.conflict_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::BothDriftedConflict);
    }

    #[test]
    fn test_twm_target_deleted() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let source = objs.clone();
        let target: Vec<ObjectDefinition> = vec![];
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.drifted_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::DeletedInTarget);
    }

    #[test]
    fn test_twm_source_deleted() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let source: Vec<ObjectDefinition> = vec![];
        let target = objs.clone();
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.drifted_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::DeletedInSource);
    }

    #[test]
    fn test_twm_new_in_both() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", vec![]);
        let source = objs.clone();
        let target = objs.clone();
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.synced_count, 1);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::NewInBoth);
    }

    #[test]
    fn test_twm_new_in_source_only() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", vec![]);
        let source = objs.clone();
        let target: Vec<ObjectDefinition> = vec![];
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.synced_count, 0);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::NewInSource);
    }

    #[test]
    fn test_twm_baseline_only() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs);
        let source: Vec<ObjectDefinition> = vec![];
        let target: Vec<ObjectDefinition> = vec![];
        let result = reconcile_three_way(&baseline, "", &source, "", &target);
        assert_eq!(result.object_reconciliations[0].status, ObjectReconciliationStatus::BaselineOnly);
    }

    // --- Fingerprint stability tests ---

    #[test]
    fn test_fingerprint_equivalent_ddl_same() {
        let ddl1 = "CREATE TABLE t1 (id INT, name TEXT)";
        let ddl2 = "CREATE   TABLE   t1   (id   INT,   name   TEXT)";
        assert_eq!(SemanticFingerprint::object_fingerprint(ddl1), SemanticFingerprint::object_fingerprint(ddl2));
    }

    #[test]
    fn test_fingerprint_crlf_vs_lf() {
        let ddl1 = "CREATE TABLE t1 (id INT)\n";
        let ddl2 = "CREATE TABLE t1 (id INT)\r\n";
        assert_eq!(SemanticFingerprint::object_fingerprint(ddl1), SemanticFingerprint::object_fingerprint(ddl2));
    }

    #[test]
    fn test_fingerprint_tabs_vs_spaces() {
        let ddl1 = "CREATE TABLE t1 (id INT)";
        let ddl2 = "CREATE\tTABLE\tt1\t(id\tINT)";
        assert_eq!(SemanticFingerprint::object_fingerprint(ddl1), SemanticFingerprint::object_fingerprint(ddl2));
    }

    #[test]
    fn test_fingerprint_different_ddl_different() {
        let ddl1 = "CREATE TABLE t1 (id INT)";
        let ddl2 = "CREATE TABLE t1 (id BIGINT)";
        assert_ne!(SemanticFingerprint::object_fingerprint(ddl1), SemanticFingerprint::object_fingerprint(ddl2));
    }

    // --- Drift detection tests ---

    #[test]
    fn test_detect_drift_no_drift() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let report = detect_drift(&baseline, &objs);
        assert!(!report.has_drift);
        assert_eq!(report.drifted_objects.len(), 0);
    }

    #[test]
    fn test_detect_drift_with_drift() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs);
        let current = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let report = detect_drift(&baseline, &current);
        assert!(report.has_drift);
        assert_eq!(report.real_drift_count, 1);
        assert_eq!(report.pseudo_drift_count, 0);
    }

    #[test]
    fn test_detect_pseudo_drift_whitespace() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs);
        let current = vec![make_table("t1", "CREATE   TABLE   t1   (id   INT)")];
        let report = detect_drift(&baseline, &current);
        // Whitespace-only changes normalize to same fingerprint → no drift
        assert!(!report.has_drift);
        assert_eq!(report.pseudo_drift_count, 0);
        assert_eq!(report.real_drift_count, 0);
    }

    #[test]
    fn test_detect_pseudo_drift_comments_only() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)\n-- this is a comment")];
        let baseline = StateSnapshot::new("baseline", objs);
        let current = vec![make_table("t1", "CREATE TABLE t1 (id INT)\n-- updated comment")];
        let report = detect_drift(&baseline, &current);
        assert!(report.has_drift);
        assert_eq!(report.pseudo_drift_count, 1);
        assert_eq!(report.real_drift_count, 0);
    }

    // --- Rebase plan tests ---

    #[test]
    fn test_rebase_plan_auto_resolve_synced() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let plan = build_rebase_plan(&baseline, &objs, &objs, true);
        assert!(!plan.requires_manual_review);
        assert_eq!(plan.proposed_objects.len(), 1);
        assert_eq!(plan.conflicts.len(), 0);
    }

    #[test]
    fn test_rebase_plan_auto_resolve_target_drifted() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs.clone());
        let source = objs.clone();
        let target = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let plan = build_rebase_plan(&baseline, &source, &target, true);
        assert!(!plan.requires_manual_review);
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(plan.conflicts[0].resolution, RebaseResolution::AcceptTarget);
    }

    #[test]
    fn test_rebase_plan_requires_manual_on_conflict() {
        let objs = vec![make_table("t1", "CREATE TABLE t1 (id INT)")];
        let baseline = StateSnapshot::new("baseline", objs);
        let source = vec![make_table("t1", "CREATE TABLE t1 (id BIGINT)")];
        let target = vec![make_table("t1", "CREATE TABLE t1 (name TEXT)")];
        let plan = build_rebase_plan(&baseline, &source, &target, true);
        assert!(plan.requires_manual_review);
        assert_eq!(plan.conflicts[0].resolution, RebaseResolution::ManualReview);
    }

    #[test]
    fn test_rebase_history_entry_creation() {
        let entry = RebaseHistoryEntry::new("baseline-1", "baseline-2", 5, 1, true, "Auto-resolved");
        assert_eq!(entry.previous_baseline_id, "baseline-1");
        assert_eq!(entry.new_baseline_id, "baseline-2");
        assert_eq!(entry.object_count, 5);
        assert_eq!(entry.conflict_count, 1);
        assert!(entry.auto_resolved);
    }

    #[test]
    fn test_filter_pseudo_drift_pure_whitespace() {
        assert!(filter_pseudo_drift("CREATE TABLE t1 (id INT)", Some("CREATE   TABLE   t1   (id   INT)")));
    }

    #[test]
    fn test_filter_pseudo_drift_comment_changes() {
        assert!(filter_pseudo_drift(
            "CREATE TABLE t1 (id INT)\n-- comment v1",
            Some("CREATE TABLE t1 (id INT)\n-- comment v2")
        ));
    }

    #[test]
    fn test_filter_pseudo_drift_real_change() {
        assert!(!filter_pseudo_drift("CREATE TABLE t1 (id INT)", Some("CREATE TABLE t1 (id BIGINT)")));
    }
}
