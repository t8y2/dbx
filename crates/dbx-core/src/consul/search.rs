use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::agent_kv::KvValueEncoding;
use crate::connection::AppState;

use super::client::client_for_state;
use super::kv::{ConsulKvRecord, MAX_RECURSIVE_ENTRIES, MAX_RECURSIVE_VALUE_BYTES};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSearchRequest {
    pub request_id: String,
    pub prefix: String,
    pub query: String,
    pub search_keys: bool,
    pub search_values: bool,
    pub case_sensitive: bool,
    pub limit: usize,
    pub max_scan: usize,
    #[serde(default)]
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSearchMatch {
    #[serde(flatten)]
    pub record: ConsulKvRecord,
    pub matches_key: bool,
    pub matches_value: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSearchResponse {
    pub matches: Vec<ConsulSearchMatch>,
    pub scanned: usize,
    pub matched: usize,
    pub limited: bool,
    pub filtered_by_acls: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSearchProgress {
    pub running: bool,
    pub scanned: usize,
    pub cancelled: bool,
}

#[derive(Default)]
struct SearchControl {
    cancelled: AtomicBool,
    scanned: AtomicUsize,
}

static SEARCHES: OnceLock<Mutex<HashMap<String, Arc<SearchControl>>>> = OnceLock::new();

struct SearchRegistration {
    key: String,
}

impl Drop for SearchRegistration {
    fn drop(&mut self) {
        if let Ok(mut searches) = searches().lock() {
            searches.remove(&self.key);
        }
    }
}

pub async fn consul_search_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulSearchRequest,
) -> Result<ConsulSearchResponse, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("CONSUL_SEARCH_QUERY_REQUIRED: Search query cannot be empty".to_string());
    }
    if !request.search_keys && !request.search_values {
        return Err("CONSUL_SEARCH_SCOPE_REQUIRED: Enable Key or Value search".to_string());
    }
    let request_id = request.request_id.trim();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("CONSUL_SEARCH_REQUEST_INVALID: Search request ID is invalid".to_string());
    }

    let client = client_for_state(state, connection_id).await?;
    let scope = client.scope();
    let key = search_key(connection_id, &scope, request.generation, request_id);
    let control = Arc::new(SearchControl::default());
    {
        let mut registry = searches().lock().map_err(|_| "Consul search registry is unavailable".to_string())?;
        if registry.contains_key(&key) {
            return Err(
                "CONSUL_OPERATION_ALREADY_RUNNING: A search with this request ID is already running".to_string()
            );
        }
        registry.insert(key.clone(), Arc::clone(&control));
    }
    let _registration = SearchRegistration { key };

    let max_scan = request.max_scan.clamp(1, MAX_RECURSIVE_ENTRIES);
    let check = |scanned: usize| {
        control.scanned.store(scanned, Ordering::Relaxed);
        if control.cancelled.load(Ordering::Relaxed) {
            Err("CONSUL_SEARCH_CANCELLED: Consul KV search was cancelled".to_string())
        } else {
            Ok(())
        }
    };
    let recursive =
        client.list_recursive_with_control(&request.prefix, max_scan, MAX_RECURSIVE_VALUE_BYTES, Some(&check)).await?;

    let normalized_query = normalize(query, request.case_sensitive);
    let limit = request.limit.clamp(1, 1000);
    let mut matched = 0usize;
    let mut matches = Vec::new();
    for (index, record) in recursive.entries.into_iter().enumerate() {
        check(index + 1)?;
        let matches_key =
            request.search_keys && normalize(&record.key, request.case_sensitive).contains(&normalized_query);
        let matches_value = request.search_values
            && matches!(record.value.encoding, KvValueEncoding::Utf8)
            && normalize(&record.value.data, request.case_sensitive).contains(&normalized_query);
        if matches_key || matches_value {
            matched += 1;
            if matches.len() < limit {
                matches.push(ConsulSearchMatch { record, matches_key, matches_value });
            }
        }
    }
    Ok(ConsulSearchResponse {
        matches,
        scanned: control.scanned.load(Ordering::Relaxed),
        matched,
        limited: matched > limit,
        filtered_by_acls: recursive.filtered_by_acls,
    })
}

pub fn consul_search_progress_core(
    connection_id: &str,
    scope: &super::ConsulScope,
    generation: u64,
    request_id: &str,
) -> ConsulSearchProgress {
    let control = searches()
        .lock()
        .ok()
        .and_then(|searches| searches.get(&search_key(connection_id, scope, generation, request_id)).cloned());
    match control {
        Some(control) => ConsulSearchProgress {
            running: true,
            scanned: control.scanned.load(Ordering::Relaxed),
            cancelled: control.cancelled.load(Ordering::Relaxed),
        },
        None => ConsulSearchProgress { running: false, scanned: 0, cancelled: false },
    }
}

pub fn consul_cancel_search_core(
    connection_id: &str,
    scope: &super::ConsulScope,
    generation: u64,
    request_id: &str,
) -> bool {
    let control = searches()
        .lock()
        .ok()
        .and_then(|searches| searches.get(&search_key(connection_id, scope, generation, request_id)).cloned());
    if let Some(control) = control {
        control.cancelled.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

fn searches() -> &'static Mutex<HashMap<String, Arc<SearchControl>>> {
    SEARCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn search_key(connection_id: &str, scope: &super::ConsulScope, generation: u64, request_id: &str) -> String {
    format!(
        "{connection_id}\0{}\0{}\0{}\0{generation}\0{request_id}",
        scope.datacenter, scope.partition, scope.namespace
    )
}

fn normalize(value: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        value.to_string()
    } else {
        value.to_lowercase()
    }
}
