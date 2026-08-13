use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::agent_kv::KvInt64;
use crate::connection::AppState;

use super::client::{client_for_state, ensure_writable_core};
use super::kv::{MAX_RECURSIVE_ENTRIES, MAX_RECURSIVE_VALUE_BYTES};
use super::txn::{delete_cas_operation, ConsulTxnRequest, MAX_TXN_OPERATIONS};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeleteCandidate {
    pub key: String,
    pub modify_index: KvInt64,
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeletePrefixPreview {
    pub prefix: String,
    pub candidates: Vec<ConsulDeleteCandidate>,
    pub filtered_by_acls: Option<bool>,
    pub complete: bool,
    pub can_execute: bool,
    pub locked: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeletePrefixRequest {
    pub prefix: String,
    pub expected: Vec<ConsulDeleteCandidate>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsulDeleteOutcome {
    Succeeded,
    Conflicted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeleteResultItem {
    pub key: String,
    pub outcome: ConsulDeleteOutcome,
    pub message: Option<String>,
    pub batch: Option<usize>,
    pub op_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulDeletePrefixReport {
    pub items: Vec<ConsulDeleteResultItem>,
    pub succeeded: usize,
    pub conflicted: usize,
    pub failed: usize,
    pub atomic: bool,
}

pub async fn consul_delete_prefix_preview_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
) -> Result<ConsulDeletePrefixPreview, String> {
    validate_prefix(prefix)?;
    let client = client_for_state(state, connection_id).await?;
    let recursive = client.list_recursive(prefix, MAX_RECURSIVE_ENTRIES, MAX_RECURSIVE_VALUE_BYTES).await?;
    let candidates = recursive
        .entries
        .into_iter()
        .map(|entry| ConsulDeleteCandidate { key: entry.key, modify_index: entry.modify_index, session: entry.session })
        .collect::<Vec<_>>();
    let locked = candidates.iter().filter(|candidate| candidate.session.is_some()).count();
    let can_execute =
        recursive.complete && recursive.filtered_by_acls != Some(true) && locked == 0 && !candidates.is_empty();
    Ok(ConsulDeletePrefixPreview {
        prefix: prefix.to_string(),
        candidates,
        filtered_by_acls: recursive.filtered_by_acls,
        complete: recursive.complete,
        can_execute,
        locked,
    })
}

pub async fn consul_delete_prefix_execute_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulDeletePrefixRequest,
) -> Result<ConsulDeletePrefixReport, String> {
    ensure_writable_core(state, connection_id, "delete Consul KV prefix").await?;
    validate_prefix(&request.prefix)?;
    if request.expected.is_empty() || request.expected.len() > MAX_RECURSIVE_ENTRIES {
        return Err("CONSUL_DELETE_PREVIEW_REQUIRED: A complete delete preview is required".to_string());
    }
    let preview = consul_delete_prefix_preview_core(state, connection_id, &request.prefix).await?;
    if !preview.can_execute {
        return Err(if preview.filtered_by_acls == Some(true) {
            "CONSUL_DELETE_ACL_FILTERED: Prefix deletion is blocked because ACL policies hide keys".to_string()
        } else if preview.locked > 0 {
            format!("CONSUL_DELETE_LOCKED: Prefix contains {} Session-locked keys", preview.locked)
        } else {
            "CONSUL_DELETE_PREVIEW_INVALID: Prefix cannot be deleted from the current preview".to_string()
        });
    }
    ensure_same_preview(&request.expected, &preview.candidates)?;

    let client = client_for_state(state, connection_id).await?;
    let mut candidates = preview.candidates;
    candidates.sort_by(|left, right| left.key.cmp(&right.key));
    let atomic = candidates.len() <= MAX_TXN_OPERATIONS;
    let mut items = Vec::with_capacity(candidates.len());
    for (batch_index, chunk) in candidates.chunks(MAX_TXN_OPERATIONS).enumerate() {
        let operations = chunk
            .iter()
            .map(|candidate| delete_cas_operation(candidate.key.clone(), candidate.modify_index.clone()))
            .collect();
        match client.txn(ConsulTxnRequest { operations }).await {
            Ok(result) if result.committed => {
                items.extend(chunk.iter().enumerate().map(|(op_index, candidate)| ConsulDeleteResultItem {
                    key: candidate.key.clone(),
                    outcome: ConsulDeleteOutcome::Succeeded,
                    message: None,
                    batch: Some(batch_index),
                    op_index: Some(op_index),
                }))
            }
            Ok(result) => {
                for (op_index, candidate) in chunk.iter().enumerate() {
                    let error = result.errors.iter().find(|error| error.op_index == op_index);
                    items.push(ConsulDeleteResultItem {
                        key: candidate.key.clone(),
                        outcome: if error.is_some() {
                            ConsulDeleteOutcome::Conflicted
                        } else {
                            ConsulDeleteOutcome::Failed
                        },
                        message: Some(
                            error
                                .map(|error| error.message.clone())
                                .unwrap_or_else(|| "Transaction batch was aborted".to_string()),
                        ),
                        batch: Some(batch_index),
                        op_index: Some(op_index),
                    });
                }
            }
            Err(error) => items.extend(chunk.iter().enumerate().map(|(op_index, candidate)| ConsulDeleteResultItem {
                key: candidate.key.clone(),
                outcome: ConsulDeleteOutcome::Failed,
                message: Some(error.clone()),
                batch: Some(batch_index),
                op_index: Some(op_index),
            })),
        }
    }
    let succeeded = items.iter().filter(|item| item.outcome == ConsulDeleteOutcome::Succeeded).count();
    let conflicted = items.iter().filter(|item| item.outcome == ConsulDeleteOutcome::Conflicted).count();
    let failed = items.iter().filter(|item| item.outcome == ConsulDeleteOutcome::Failed).count();
    Ok(ConsulDeletePrefixReport { items, succeeded, conflicted, failed, atomic })
}

fn ensure_same_preview(expected: &[ConsulDeleteCandidate], current: &[ConsulDeleteCandidate]) -> Result<(), String> {
    let expected =
        expected.iter().map(|candidate| (&candidate.key, candidate.modify_index.as_str())).collect::<BTreeMap<_, _>>();
    let current =
        current.iter().map(|candidate| (&candidate.key, candidate.modify_index.as_str())).collect::<BTreeMap<_, _>>();
    if expected != current {
        return Err(
            "CONSUL_DELETE_PREVIEW_STALE: Prefix contents changed after preview; refresh before deleting".to_string()
        );
    }
    Ok(())
}

fn validate_prefix(prefix: &str) -> Result<(), String> {
    if prefix.trim().is_empty() {
        return Err("CONSUL_DELETE_PREFIX_REQUIRED: Deleting the entire Consul KV root is not allowed".to_string());
    }
    Ok(())
}
