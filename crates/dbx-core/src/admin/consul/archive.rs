use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::agent_kv::{KvInt64, KvValue};
use crate::connection::AppState;

use super::client::{client_for_state, ensure_writable_core, ConsulClient};
use super::kv::{ConsulKvRecord, MAX_RECURSIVE_ENTRIES, MAX_RECURSIVE_VALUE_BYTES};
use super::txn::{cas_operation, ConsulTxnRequest, MAX_TXN_OPERATIONS};

const CONSUL_BUNDLE_FORMAT: &str = "dbx-consul-kv-bundle";
const CONSUL_BUNDLE_VERSION: u32 = 1;
const MAX_VALUE_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsulExportScopeKind {
    Key,
    Prefix,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulExportRequest {
    pub path: String,
    pub kind: ConsulExportScopeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulBundleScope {
    pub datacenter: String,
    pub namespace: String,
    pub partition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulBundleEntry {
    pub key: String,
    pub value: KvValue,
    pub flags: KvInt64,
    pub create_index: Option<KvInt64>,
    pub modify_index: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulKvBundle {
    pub format: String,
    pub version: u32,
    pub exported_at_unix_ms: u64,
    pub prefix: String,
    pub scope_kind: ConsulExportScopeKind,
    pub source: ConsulBundleScope,
    pub entries: Vec<ConsulBundleEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsulImportConflictPolicy {
    Abort,
    Skip,
    Cas,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsulImportOperation {
    Create,
    Update,
    Unchanged,
    Skipped,
    Conflict,
    Locked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulImportPreviewRow {
    pub key: String,
    pub operation: ConsulImportOperation,
    pub expected_modify_index: Option<KvInt64>,
    pub target_session: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulImportPreview {
    pub preview_id: String,
    pub rows: Vec<ConsulImportPreviewRow>,
    pub can_apply: bool,
    pub creates: usize,
    pub updates: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub conflicts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulImportRequest {
    pub bundle: ConsulKvBundle,
    pub policy: ConsulImportConflictPolicy,
    #[serde(default)]
    pub preview_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsulImportOutcome {
    Succeeded,
    Conflicted,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulImportResultItem {
    pub key: String,
    pub outcome: ConsulImportOutcome,
    pub message: Option<String>,
    pub batch: Option<usize>,
    pub op_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulImportReport {
    pub items: Vec<ConsulImportResultItem>,
    pub succeeded: usize,
    pub conflicted: usize,
    pub skipped: usize,
    pub failed: usize,
    pub atomic: bool,
}

pub async fn consul_export_bundle_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulExportRequest,
) -> Result<ConsulKvBundle, String> {
    let client = client_for_state(state, connection_id).await?;
    let entries = match request.kind {
        ConsulExportScopeKind::Key => {
            let value = client.get_key(&request.path).await?;
            if !value.found {
                return Err("CONSUL_KEY_NOT_FOUND: The Consul KV key no longer exists".to_string());
            }
            let metadata = value.metadata.unwrap_or_else(empty_metadata);
            vec![ConsulBundleEntry {
                key: value.key.unwrap_or(request.path.clone()),
                value: value.value.ok_or("Consul returned a KV key without a value")?,
                flags: metadata.flags.unwrap_or_else(|| KvInt64("0".to_string())),
                create_index: metadata.create_revision,
                modify_index: metadata.mod_revision,
            }]
        }
        ConsulExportScopeKind::Prefix => {
            let recursive =
                client.list_recursive(&request.path, MAX_RECURSIVE_ENTRIES, MAX_RECURSIVE_VALUE_BYTES).await?;
            if recursive.filtered_by_acls == Some(true) {
                return Err(
                    "CONSUL_EXPORT_ACL_FILTERED: Export is blocked because ACL policies hide part of the prefix"
                        .to_string(),
                );
            }
            recursive.entries.into_iter().map(bundle_entry_from_record).collect()
        }
    };
    Ok(ConsulKvBundle {
        format: CONSUL_BUNDLE_FORMAT.to_string(),
        version: CONSUL_BUNDLE_VERSION,
        exported_at_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        prefix: request.path,
        scope_kind: request.kind,
        source: ConsulBundleScope {
            datacenter: client.datacenter().to_string(),
            namespace: client.namespace().to_string(),
            partition: client.partition().to_string(),
        },
        entries,
    })
}

pub async fn consul_import_preview_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulImportRequest,
) -> Result<ConsulImportPreview, String> {
    validate_bundle(&request.bundle)?;
    let client = client_for_state(state, connection_id).await?;
    build_preview(&client, connection_id, &request.bundle, request.policy).await
}

pub async fn consul_import_execute_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulImportRequest,
) -> Result<ConsulImportReport, String> {
    ensure_writable_core(state, connection_id, "import Consul KV bundle").await?;
    validate_bundle(&request.bundle)?;
    let client = client_for_state(state, connection_id).await?;
    let preview = build_preview(&client, connection_id, &request.bundle, request.policy).await?;
    if request.preview_id.as_deref() != Some(preview.preview_id.as_str()) {
        return Err(
            "CONSUL_IMPORT_PREVIEW_STALE: Target state changed after preview; refresh before importing".to_string()
        );
    }
    if !preview.can_apply {
        return Ok(report_from_blocked_preview(preview));
    }

    let preview_by_key =
        preview.rows.into_iter().map(|row| (row.key.clone(), row)).collect::<std::collections::HashMap<_, _>>();
    let mut items = Vec::with_capacity(request.bundle.entries.len());
    let mut sources = request.bundle.entries;
    sources.sort_by(|left, right| left.key.cmp(&right.key));
    let mut pending = Vec::new();
    for source in sources {
        let Some(row) = preview_by_key.get(&source.key) else {
            continue;
        };
        match row.operation {
            ConsulImportOperation::Unchanged | ConsulImportOperation::Skipped => {
                items.push(result_item(source.key, ConsulImportOutcome::Skipped, row.reason.clone(), None, None));
            }
            ConsulImportOperation::Conflict | ConsulImportOperation::Locked => {
                items.push(result_item(source.key, ConsulImportOutcome::Conflicted, row.reason.clone(), None, None));
            }
            ConsulImportOperation::Create | ConsulImportOperation::Update => {
                let index = row.expected_modify_index.clone().unwrap_or_else(|| KvInt64("0".to_string()));
                pending.push((source.key.clone(), cas_operation(source.key, source.value, source.flags, index)));
            }
        }
    }
    let atomic = pending.len() <= MAX_TXN_OPERATIONS;
    for (batch_index, chunk) in pending.chunks(MAX_TXN_OPERATIONS).enumerate() {
        let result = client
            .txn(ConsulTxnRequest { operations: chunk.iter().map(|(_, operation)| operation.clone()).collect() })
            .await;
        match result {
            Ok(result) if result.committed => {
                items.extend(chunk.iter().enumerate().map(|(op_index, (key, _))| {
                    result_item(key.clone(), ConsulImportOutcome::Succeeded, None, Some(batch_index), Some(op_index))
                }));
            }
            Ok(result) => {
                for (op_index, (key, _)) in chunk.iter().enumerate() {
                    let error = result.errors.iter().find(|error| error.op_index == op_index);
                    items.push(result_item(
                        key.clone(),
                        if error.is_some() { ConsulImportOutcome::Conflicted } else { ConsulImportOutcome::Failed },
                        Some(
                            error
                                .map(|error| error.message.clone())
                                .unwrap_or_else(|| "Transaction batch was aborted".to_string()),
                        ),
                        Some(batch_index),
                        Some(op_index),
                    ));
                }
            }
            Err(error) => items.extend(chunk.iter().enumerate().map(|(op_index, (key, _))| {
                result_item(
                    key.clone(),
                    ConsulImportOutcome::Failed,
                    Some(error.clone()),
                    Some(batch_index),
                    Some(op_index),
                )
            })),
        }
    }
    Ok(summarize_report(items, atomic))
}

async fn build_preview(
    client: &ConsulClient,
    connection_id: &str,
    bundle: &ConsulKvBundle,
    policy: ConsulImportConflictPolicy,
) -> Result<ConsulImportPreview, String> {
    let mut rows = Vec::with_capacity(bundle.entries.len());
    for source in &bundle.entries {
        let target = client.get_key(&source.key).await?;
        let row = if !target.found {
            ConsulImportPreviewRow {
                key: source.key.clone(),
                operation: ConsulImportOperation::Create,
                expected_modify_index: None,
                target_session: None,
                reason: None,
            }
        } else {
            preview_existing(source, target, policy)
        };
        rows.push(row);
    }
    let creates = count_operation(&rows, ConsulImportOperation::Create);
    let updates = count_operation(&rows, ConsulImportOperation::Update);
    let unchanged = count_operation(&rows, ConsulImportOperation::Unchanged);
    let skipped = count_operation(&rows, ConsulImportOperation::Skipped);
    let conflicts =
        count_operation(&rows, ConsulImportOperation::Conflict) + count_operation(&rows, ConsulImportOperation::Locked);
    let can_apply = conflicts == 0 || policy != ConsulImportConflictPolicy::Abort;
    let preview_id = preview_id(&rows, bundle, policy, connection_id, client);
    Ok(ConsulImportPreview { preview_id, rows, can_apply, creates, updates, unchanged, skipped, conflicts })
}

fn preview_existing(
    source: &ConsulBundleEntry,
    target: crate::agent_kv::KvGetResponse,
    policy: ConsulImportConflictPolicy,
) -> ConsulImportPreviewRow {
    let metadata = target.metadata.unwrap_or_else(empty_metadata);
    let target_session = metadata.session.filter(|session| !session.is_empty());
    if target_session.is_some() {
        return ConsulImportPreviewRow {
            key: source.key.clone(),
            operation: ConsulImportOperation::Locked,
            expected_modify_index: metadata.mod_revision,
            target_session,
            reason: Some("Target key is held by a Consul Session".to_string()),
        };
    }
    let target_flags = metadata.flags.unwrap_or_else(|| KvInt64("0".to_string()));
    if target.value.as_ref() == Some(&source.value) && target_flags == source.flags {
        return ConsulImportPreviewRow {
            key: source.key.clone(),
            operation: ConsulImportOperation::Unchanged,
            expected_modify_index: metadata.mod_revision,
            target_session: None,
            reason: None,
        };
    }
    let (operation, reason) = match policy {
        ConsulImportConflictPolicy::Abort => {
            (ConsulImportOperation::Conflict, Some("Target key exists with a different value or Flags".to_string()))
        }
        ConsulImportConflictPolicy::Skip => {
            (ConsulImportOperation::Skipped, Some("Existing target key is skipped by the selected policy".to_string()))
        }
        ConsulImportConflictPolicy::Cas => (ConsulImportOperation::Update, None),
    };
    ConsulImportPreviewRow {
        key: source.key.clone(),
        operation,
        expected_modify_index: metadata.mod_revision,
        target_session: None,
        reason,
    }
}

fn validate_bundle(bundle: &ConsulKvBundle) -> Result<(), String> {
    if bundle.format != CONSUL_BUNDLE_FORMAT || bundle.version != CONSUL_BUNDLE_VERSION {
        return Err("CONSUL_BUNDLE_UNSUPPORTED: Expected DBX Consul KV bundle version 1".to_string());
    }
    if bundle.entries.len() > MAX_RECURSIVE_ENTRIES {
        return Err(format!("CONSUL_BUNDLE_TOO_LARGE: Bundle contains more than {MAX_RECURSIVE_ENTRIES} keys"));
    }
    let mut keys = HashSet::with_capacity(bundle.entries.len());
    let mut total_bytes = 0usize;
    for entry in &bundle.entries {
        if entry.key.is_empty() {
            return Err("CONSUL_BUNDLE_INVALID: Bundle contains an empty key".to_string());
        }
        if !keys.insert(&entry.key) {
            return Err(format!("CONSUL_BUNDLE_INVALID: Duplicate key in bundle: {}", entry.key));
        }
        entry
            .flags
            .as_str()
            .parse::<u64>()
            .map_err(|_| format!("CONSUL_BUNDLE_INVALID: Invalid Flags for key {}", entry.key))?;
        let value_bytes = value_size(&entry.value)?;
        if value_bytes > MAX_VALUE_BYTES {
            return Err(format!("CONSUL_VALUE_TOO_LARGE: Bundle value exceeds 512 KiB for key {}", entry.key));
        }
        total_bytes = total_bytes.saturating_add(value_bytes);
        if total_bytes > MAX_RECURSIVE_VALUE_BYTES {
            return Err("CONSUL_BUNDLE_TOO_LARGE: Bundle values exceed 32 MiB".to_string());
        }
    }
    Ok(())
}

fn value_size(value: &KvValue) -> Result<usize, String> {
    match value.encoding {
        crate::agent_kv::KvValueEncoding::Utf8 => Ok(value.data.len()),
        crate::agent_kv::KvValueEncoding::Base64 => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(value.data.chars().filter(|char| !char.is_whitespace()).collect::<String>())
                .map(|bytes| bytes.len())
                .map_err(|error| format!("CONSUL_BUNDLE_INVALID: Invalid Base64 value: {error}"))
        }
    }
}

fn bundle_entry_from_record(record: ConsulKvRecord) -> ConsulBundleEntry {
    ConsulBundleEntry {
        key: record.key,
        value: record.value,
        flags: record.flags,
        create_index: Some(record.create_index),
        modify_index: Some(record.modify_index),
    }
}

fn report_from_blocked_preview(preview: ConsulImportPreview) -> ConsulImportReport {
    let items = preview
        .rows
        .into_iter()
        .map(|row| {
            let outcome = if matches!(row.operation, ConsulImportOperation::Conflict | ConsulImportOperation::Locked) {
                ConsulImportOutcome::Conflicted
            } else {
                ConsulImportOutcome::Skipped
            };
            result_item(row.key, outcome, row.reason, None, None)
        })
        .collect();
    summarize_report(items, false)
}

fn summarize_report(items: Vec<ConsulImportResultItem>, atomic: bool) -> ConsulImportReport {
    let succeeded = items.iter().filter(|item| item.outcome == ConsulImportOutcome::Succeeded).count();
    let conflicted = items.iter().filter(|item| item.outcome == ConsulImportOutcome::Conflicted).count();
    let skipped = items.iter().filter(|item| item.outcome == ConsulImportOutcome::Skipped).count();
    let failed = items.iter().filter(|item| item.outcome == ConsulImportOutcome::Failed).count();
    ConsulImportReport { items, succeeded, conflicted, skipped, failed, atomic }
}

fn result_item(
    key: String,
    outcome: ConsulImportOutcome,
    message: Option<String>,
    batch: Option<usize>,
    op_index: Option<usize>,
) -> ConsulImportResultItem {
    ConsulImportResultItem { key, outcome, message, batch, op_index }
}

fn preview_id(
    rows: &[ConsulImportPreviewRow],
    bundle: &ConsulKvBundle,
    policy: ConsulImportConflictPolicy,
    connection_id: &str,
    client: &ConsulClient,
) -> String {
    preview_id_for_scope(rows, bundle, policy, connection_id, &client.scope())
}

fn preview_id_for_scope(
    rows: &[ConsulImportPreviewRow],
    bundle: &ConsulKvBundle,
    policy: ConsulImportConflictPolicy,
    connection_id: &str,
    scope: &super::ConsulScope,
) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    let canonical = serde_json::to_vec(&(connection_id, scope, bundle, policy, rows)).unwrap_or_default();
    for byte in canonical {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("consul-preview-{hash:016x}")
}

fn count_operation(rows: &[ConsulImportPreviewRow], operation: ConsulImportOperation) -> usize {
    rows.iter().filter(|row| row.operation == operation).count()
}

fn empty_metadata() -> crate::agent_kv::KvKeyMetadata {
    crate::agent_kv::KvKeyMetadata {
        create_revision: None,
        mod_revision: None,
        version: None,
        lease: None,
        ttl: None,
        value_size: None,
        czxid: None,
        mzxid: None,
        pzxid: None,
        ctime: None,
        mtime: None,
        cversion: None,
        aversion: None,
        ephemeral_owner: None,
        data_length: None,
        num_children: None,
        flags: None,
        lock_index: None,
        session: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_kv::{KvGetResponse, KvKeyMetadata, KvValueEncoding};

    #[test]
    fn bundle_validation_rejects_wrong_format_and_duplicate_keys() {
        let mut bundle = test_bundle();
        bundle.format = "wrong".to_string();
        assert!(validate_bundle(&bundle).unwrap_err().contains("CONSUL_BUNDLE_UNSUPPORTED"));

        let mut bundle = test_bundle();
        bundle.entries.push(bundle.entries[0].clone());
        assert!(validate_bundle(&bundle).unwrap_err().contains("Duplicate key"));
    }

    #[test]
    fn bundle_round_trips_binary_values_and_u64_flags_without_sensitive_fields() {
        let mut bundle = test_bundle();
        bundle.entries[0].value = KvValue { encoding: KvValueEncoding::Base64, data: "AP+A".into() };
        bundle.entries[0].flags = KvInt64(u64::MAX.to_string());
        let encoded = serde_json::to_string(&bundle).unwrap();
        for forbidden in ["SecretID", "X-Consul-Token", "session", "lockIndex"] {
            assert!(!encoded.contains(forbidden));
        }
        let decoded: ConsulKvBundle = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.entries[0].value.data, "AP+A");
        assert_eq!(decoded.entries[0].flags.as_str(), u64::MAX.to_string());
    }

    #[test]
    fn existing_key_policy_is_explicit() {
        let source = test_bundle().entries.remove(0);
        let target = || KvGetResponse {
            key: Some(source.key.clone()),
            key_bytes: None,
            found: true,
            value: Some(KvValue { encoding: KvValueEncoding::Utf8, data: "different".to_string() }),
            metadata: Some(KvKeyMetadata { mod_revision: Some(KvInt64("9".to_string())), ..empty_metadata() }),
        };

        assert_eq!(
            preview_existing(&source, target(), ConsulImportConflictPolicy::Abort).operation,
            ConsulImportOperation::Conflict
        );
        assert_eq!(
            preview_existing(&source, target(), ConsulImportConflictPolicy::Skip).operation,
            ConsulImportOperation::Skipped
        );
        assert_eq!(
            preview_existing(&source, target(), ConsulImportConflictPolicy::Cas).operation,
            ConsulImportOperation::Update
        );
    }

    #[test]
    fn preview_id_binds_target_state_bundle_content_and_policy() {
        let scope = super::super::ConsulScope {
            datacenter: "dc1".into(),
            namespace: "team".into(),
            partition: "default".into(),
        };
        let bundle = test_bundle();
        let row = |index: &str| ConsulImportPreviewRow {
            key: "app/key".into(),
            operation: ConsulImportOperation::Update,
            expected_modify_index: Some(KvInt64(index.into())),
            target_session: None,
            reason: None,
        };

        let initial = preview_id_for_scope(&[row("9")], &bundle, ConsulImportConflictPolicy::Cas, "target-a", &scope);
        assert_ne!(
            initial,
            preview_id_for_scope(&[row("10")], &bundle, ConsulImportConflictPolicy::Cas, "target-a", &scope)
        );
        assert_ne!(
            initial,
            preview_id_for_scope(&[row("9")], &bundle, ConsulImportConflictPolicy::Cas, "target-b", &scope)
        );

        let mut changed_bundle = bundle.clone();
        changed_bundle.entries[0].value.data = "changed-after-preview".into();
        assert_ne!(
            initial,
            preview_id_for_scope(&[row("9")], &changed_bundle, ConsulImportConflictPolicy::Cas, "target-a", &scope)
        );
        assert_ne!(
            initial,
            preview_id_for_scope(&[row("9")], &bundle, ConsulImportConflictPolicy::Skip, "target-a", &scope)
        );
    }

    fn test_bundle() -> ConsulKvBundle {
        ConsulKvBundle {
            format: CONSUL_BUNDLE_FORMAT.into(),
            version: CONSUL_BUNDLE_VERSION,
            exported_at_unix_ms: 1,
            prefix: "app/".into(),
            scope_kind: ConsulExportScopeKind::Prefix,
            source: ConsulBundleScope {
                datacenter: "dc1".into(),
                namespace: "team".into(),
                partition: "default".into(),
            },
            entries: vec![ConsulBundleEntry {
                key: "app/key".into(),
                value: KvValue { encoding: KvValueEncoding::Utf8, data: "value".into() },
                flags: KvInt64("0".into()),
                create_index: Some(KvInt64("1".into())),
                modify_index: Some(KvInt64("2".into())),
            }],
        }
    }
}
