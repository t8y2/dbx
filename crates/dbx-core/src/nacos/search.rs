use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use futures::{stream, StreamExt};
use tokio_util::sync::CancellationToken;

use crate::nacos::port::NacosAdmin;
use crate::nacos::types::{
    NacosConfigItem, NacosConfigKey, NacosConfigQuery, NacosContentMatch, NacosContentSearchRequest,
    NacosContentSearchResult, NacosNamespaceScope, NacosSearchFailure, NacosSearchProgress,
};

const SEARCH_PAGE_SIZE: u32 = 500;
const SEARCH_CONCURRENCY: usize = 8;
const SEARCH_RESULT_BATCH_SIZE: usize = 50;
const MAX_SEARCH_RESULTS: usize = 10_000;

struct CandidateCollection {
    items: Vec<NacosConfigItem>,
    incomplete_reason: Option<String>,
}

fn operations() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static OPERATIONS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn begin_operation(operation_id: &str) -> Result<CancellationToken, String> {
    let operation_id = operation_id.trim();
    if operation_id.is_empty() {
        return Err("Nacos operation ID is required".to_string());
    }
    let mut operations = operations().lock().map_err(|_| "Nacos operation registry is unavailable".to_string())?;
    if operations.contains_key(operation_id) {
        return Err("A Nacos operation with this ID is already running".to_string());
    }
    let token = CancellationToken::new();
    operations.insert(operation_id.to_string(), token.clone());
    Ok(token)
}

pub fn cancel_operation(operation_id: &str) -> bool {
    let Ok(operations) = operations().lock() else {
        return false;
    };
    let Some(token) = operations.get(operation_id) else {
        return false;
    };
    token.cancel();
    true
}

pub(crate) fn finish_operation(operation_id: &str) {
    if let Ok(mut operations) = operations().lock() {
        operations.remove(operation_id);
    }
}

struct OperationGuard(String);

impl Drop for OperationGuard {
    fn drop(&mut self) {
        finish_operation(&self.0);
    }
}

pub async fn search_config_content<F>(
    admin: Arc<dyn NacosAdmin>,
    request: NacosContentSearchRequest,
    on_progress: F,
) -> Result<NacosContentSearchResult, String>
where
    F: Fn(NacosSearchProgress) + Send + Sync,
{
    let query = request.query.clone();
    if query.is_empty() {
        return Err("Nacos configuration content search query is required".to_string());
    }
    if query.chars().count() > 1_024 {
        return Err("Nacos configuration content search query exceeds the 1024 character limit".to_string());
    }
    let token = begin_operation(&request.operation_id)?;
    let _guard = OperationGuard(request.operation_id.clone());
    let namespaces = resolve_namespaces(admin.as_ref(), &request).await?;
    let result_limit = request.max_results.unwrap_or(MAX_SEARCH_RESULTS).clamp(1, MAX_SEARCH_RESULTS);
    let literal_requires_scan = query.chars().any(|ch| matches!(ch, '*' | '/' | '%' | '_' | '\\'));
    let mut result = NacosContentSearchResult {
        operation_id: request.operation_id.clone(),
        scanned: 0,
        matches: Vec::new(),
        failures: Vec::new(),
        truncated: false,
        cancelled: false,
        incomplete: false,
    };
    let mut pending_matches = Vec::new();

    for namespace in namespaces {
        if token.is_cancelled() || result.truncated {
            break;
        }
        let candidates = if literal_requires_scan {
            enumerate_namespace(admin.as_ref(), &namespace, &request, &token, &on_progress, &result).await
        } else {
            native_or_enumerated_candidates(admin.as_ref(), &namespace, &request, &token, &on_progress, &result).await
        };
        let candidates = match candidates {
            Ok(mut candidates) => {
                if let Some(error) = candidates.incomplete_reason.take() {
                    result.failures.push(NacosSearchFailure { namespace: namespace.clone(), error });
                    result.incomplete = true;
                }
                let mut seen = HashSet::new();
                candidates
                    .items
                    .retain(|item| seen.insert((item.namespace.clone(), item.group.clone(), item.data_id.clone())));
                candidates.items
            }
            Err(error) => {
                result.failures.push(NacosSearchFailure { namespace: namespace.clone(), error });
                result.incomplete = true;
                emit_progress(
                    &on_progress,
                    &request.operation_id,
                    "namespaceFailed",
                    Some(namespace),
                    &result,
                    std::mem::take(&mut pending_matches),
                    false,
                );
                continue;
            }
        };
        let request_group = request.group.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let request_data_id = request.data_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let details = stream::iter(candidates.into_iter().filter(|item| {
            request_group.is_none_or(|group| item.group.contains(group))
                && request_data_id.is_none_or(|data_id| item.data_id.contains(data_id))
        }))
        .map(|item| {
            let admin = admin.clone();
            let token = token.clone();
            async move {
                if token.is_cancelled() {
                    return None;
                }
                let key = NacosConfigKey {
                    namespace: Some(item.namespace.clone()),
                    data_id: item.data_id,
                    group: item.group,
                };
                Some((key.clone(), admin.get_config(key).await))
            }
        })
        .buffer_unordered(SEARCH_CONCURRENCY);
        futures::pin_mut!(details);

        while let Some(detail) = details.next().await {
            if token.is_cancelled() || result.truncated {
                break;
            }
            let Some((key, detail)) = detail else {
                continue;
            };
            result.scanned += 1;
            match detail {
                Ok(item) => {
                    if let Some(content_match) = find_first_match(&item, &query) {
                        result.matches.push(content_match.clone());
                        pending_matches.push(content_match);
                        if result.matches.len() >= result_limit {
                            result.truncated = true;
                        }
                    }
                }
                Err(error) => {
                    result.failures.push(NacosSearchFailure {
                        namespace: key.namespace.unwrap_or_default(),
                        error: format!("{} / {}: {error}", key.group, key.data_id),
                    });
                    result.incomplete = true;
                }
            }
            if pending_matches.len() >= SEARCH_RESULT_BATCH_SIZE {
                emit_progress(
                    &on_progress,
                    &request.operation_id,
                    "searching",
                    Some(namespace.clone()),
                    &result,
                    std::mem::take(&mut pending_matches),
                    false,
                );
            }
        }
    }
    result.cancelled = token.is_cancelled();
    result.incomplete |= result.cancelled || result.truncated || !result.failures.is_empty();
    emit_progress(
        &on_progress,
        &request.operation_id,
        if result.cancelled { "cancelled" } else { "completed" },
        None,
        &result,
        pending_matches,
        true,
    );
    Ok(result)
}

async fn resolve_namespaces(
    admin: &dyn NacosAdmin,
    request: &NacosContentSearchRequest,
) -> Result<Vec<String>, String> {
    match request.scope {
        NacosNamespaceScope::CurrentNamespace => Ok(vec![request.namespace.clone().unwrap_or_default()]),
        NacosNamespaceScope::AllNamespaces => {
            let namespaces = admin.list_namespaces().await?;
            Ok(namespaces.into_iter().map(|item| item.namespace).collect())
        }
    }
}

async fn native_or_enumerated_candidates<F>(
    admin: &dyn NacosAdmin,
    namespace: &str,
    request: &NacosContentSearchRequest,
    token: &CancellationToken,
    on_progress: &F,
    result: &NacosContentSearchResult,
) -> Result<CandidateCollection, String>
where
    F: Fn(NacosSearchProgress) + Send + Sync,
{
    let first = admin.search_config_content_page(namespace, &request.query, 1, SEARCH_PAGE_SIZE).await?;
    let Some(first) = first else {
        return enumerate_namespace(admin, namespace, request, token, on_progress, result).await;
    };
    collect_native_pages(admin, namespace, &request.query, first, token, on_progress, request, result).await
}

async fn collect_native_pages<F>(
    admin: &dyn NacosAdmin,
    namespace: &str,
    query: &str,
    first: crate::nacos::types::NacosConfigList,
    token: &CancellationToken,
    on_progress: &F,
    request: &NacosContentSearchRequest,
    result: &NacosContentSearchResult,
) -> Result<CandidateCollection, String>
where
    F: Fn(NacosSearchProgress) + Send + Sync,
{
    let total = first.total_count;
    let mut items = first.items;
    let mut seen: HashSet<_> =
        items.iter().map(|item| (item.namespace.clone(), item.group.clone(), item.data_id.clone())).collect();
    let mut page_no = 2;
    let mut incomplete_reason = None;
    while (items.len() as u64) < total {
        if token.is_cancelled() {
            break;
        }
        emit_candidate_progress(on_progress, request, namespace, result, items.len() as u64, Some(total));
        let Some(page) = admin.search_config_content_page(namespace, query, page_no, SEARCH_PAGE_SIZE).await? else {
            return Err("Nacos native content-search endpoint became unavailable during pagination".to_string());
        };
        if page.items.is_empty() {
            break;
        }
        let before = items.len();
        items.extend(
            page.items
                .into_iter()
                .filter(|item| seen.insert((item.namespace.clone(), item.group.clone(), item.data_id.clone()))),
        );
        if items.len() == before {
            incomplete_reason =
                Some("Nacos content-search pagination stopped because the server repeated a page".to_string());
            break;
        }
        page_no = match page_no.checked_add(1) {
            Some(next) => next,
            None => {
                incomplete_reason =
                    Some("Nacos content-search pagination exceeded the supported page range".to_string());
                break;
            }
        };
    }
    Ok(CandidateCollection { items, incomplete_reason })
}

async fn enumerate_namespace<F>(
    admin: &dyn NacosAdmin,
    namespace: &str,
    request: &NacosContentSearchRequest,
    token: &CancellationToken,
    on_progress: &F,
    result: &NacosContentSearchResult,
) -> Result<CandidateCollection, String>
where
    F: Fn(NacosSearchProgress) + Send + Sync,
{
    let mut page_no = 1;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut incomplete_reason = None;
    loop {
        if token.is_cancelled() {
            break;
        }
        let page = admin
            .list_configs(NacosConfigQuery {
                namespace: Some(namespace.to_string()),
                group: request.group.clone(),
                data_id: None,
                app_name: None,
                search: None,
                page_no: Some(page_no),
                page_size: Some(SEARCH_PAGE_SIZE),
            })
            .await?;
        let total = page.total_count;
        let empty = page.items.is_empty();
        let before = items.len();
        items.extend(
            page.items
                .into_iter()
                .filter(|item| seen.insert((item.namespace.clone(), item.group.clone(), item.data_id.clone()))),
        );
        emit_candidate_progress(on_progress, request, namespace, result, items.len() as u64, Some(total));
        if empty || total == 0 || items.len() as u64 >= total {
            break;
        }
        if items.len() == before {
            incomplete_reason =
                Some("Nacos configuration pagination stopped because the server repeated a page".to_string());
            break;
        }
        page_no = match page_no.checked_add(1) {
            Some(next) => next,
            None => {
                incomplete_reason =
                    Some("Nacos configuration pagination exceeded the supported page range".to_string());
                break;
            }
        };
    }
    Ok(CandidateCollection { items, incomplete_reason })
}

fn emit_candidate_progress<F>(
    on_progress: &F,
    request: &NacosContentSearchRequest,
    namespace: &str,
    result: &NacosContentSearchResult,
    enumerated: u64,
    total: Option<u64>,
) where
    F: Fn(NacosSearchProgress) + Send + Sync,
{
    on_progress(NacosSearchProgress {
        operation_id: request.operation_id.clone(),
        phase: "enumerating".to_string(),
        namespace: Some(namespace.to_string()),
        scanned: result.scanned,
        total: total.or(Some(enumerated)),
        matched: result.matches.len() as u64,
        matches: Vec::new(),
        failures: result.failures.clone(),
        truncated: result.truncated,
        cancelled: false,
        done: false,
    });
}

fn emit_progress<F>(
    on_progress: &F,
    operation_id: &str,
    phase: &str,
    namespace: Option<String>,
    result: &NacosContentSearchResult,
    matches: Vec<NacosContentMatch>,
    done: bool,
) where
    F: Fn(NacosSearchProgress) + Send + Sync,
{
    on_progress(NacosSearchProgress {
        operation_id: operation_id.to_string(),
        phase: phase.to_string(),
        namespace,
        scanned: result.scanned,
        total: None,
        matched: result.matches.len() as u64,
        matches,
        failures: result.failures.clone(),
        truncated: result.truncated,
        cancelled: result.cancelled,
        done,
    });
}

fn find_first_match(item: &NacosConfigItem, query: &str) -> Option<NacosContentMatch> {
    let content = item.content.as_deref()?;
    let offset = content.find(query)?;
    let line_number = content[..offset].bytes().filter(|byte| *byte == b'\n').count() as u64 + 1;
    let line_start = content[..offset].rfind('\n').map(|value| value + 1).unwrap_or(0);
    let line_end = content[offset..].find('\n').map(|value| offset + value).unwrap_or(content.len());
    let line = &content[line_start..line_end];
    let match_in_line = offset - line_start;
    let prefix_chars = line[..match_in_line].chars().count();
    let query_chars = query.chars().count();
    let snippet_limit = 240usize.max(query_chars);
    let start_char = prefix_chars.saturating_sub(80);
    let chars: Vec<char> = line.chars().collect();
    let end_char = (start_char + snippet_limit).max(prefix_chars + query_chars).min(chars.len());
    let mut snippet: String = chars[start_char..end_char].iter().collect();
    if start_char > 0 {
        snippet.insert(0, '…');
    }
    if end_char < chars.len() {
        snippet.push('…');
    }
    Some(NacosContentMatch {
        namespace: item.namespace.clone(),
        group: item.group.clone(),
        data_id: item.data_id.clone(),
        line_number,
        snippet,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::nacos::types::*;

    struct MockAdmin {
        ordered: Vec<NacosConfigItem>,
        details: HashMap<(String, String, String), NacosConfigItem>,
        native_error: Option<String>,
        list_calls: AtomicUsize,
        repeated_pages: bool,
        reported_total: Option<u64>,
    }

    impl MockAdmin {
        fn new(items: Vec<NacosConfigItem>) -> Self {
            let details = items
                .iter()
                .cloned()
                .map(|item| ((item.namespace.clone(), item.group.clone(), item.data_id.clone()), item))
                .collect();
            Self {
                ordered: items,
                details,
                native_error: None,
                list_calls: AtomicUsize::new(0),
                repeated_pages: false,
                reported_total: None,
            }
        }
    }

    #[async_trait]
    impl NacosAdmin for MockAdmin {
        async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
            Err("unused".to_string())
        }
        async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
            Ok(vec![])
        }
        async fn create_namespace(&self, _: NacosNamespaceCreate) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn update_namespace(&self, _: NacosNamespaceUpdate) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn list_configs(&self, query: NacosConfigQuery) -> Result<NacosConfigList, String> {
            self.list_calls.fetch_add(1, Ordering::SeqCst);
            let page_no = query.page_no.unwrap_or(1);
            let page_size = query.page_size.unwrap_or(500);
            let start = if self.repeated_pages { 0 } else { ((page_no - 1) * page_size) as usize };
            let end = (start + page_size as usize).min(self.ordered.len());
            let items = if start < self.ordered.len() { self.ordered[start..end].to_vec() } else { Vec::new() };
            Ok(NacosConfigList {
                page_no,
                page_size,
                total_count: self.reported_total.unwrap_or(self.ordered.len() as u64),
                items,
            })
        }
        async fn search_config_content_page(
            &self,
            _: &str,
            _: &str,
            _: u32,
            _: u32,
        ) -> Result<Option<NacosConfigList>, String> {
            match &self.native_error {
                Some(error) => Err(error.clone()),
                None => Ok(None),
            }
        }
        async fn get_config(&self, key: NacosConfigKey) -> Result<NacosConfigItem, String> {
            self.details
                .get(&(key.namespace.unwrap_or_default(), key.group, key.data_id))
                .cloned()
                .ok_or_else(|| "not found".to_string())
        }
        async fn publish_config(&self, _: NacosConfigUpsert) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn delete_config(&self, _: NacosConfigKey) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn list_config_history(&self, _: NacosConfigHistoryQuery) -> Result<NacosConfigHistoryList, String> {
            Err("unused".to_string())
        }
        async fn get_config_history(&self, _: NacosConfigHistoryKey) -> Result<NacosConfigItem, String> {
            Err("unused".to_string())
        }
        async fn rollback_config(&self, _: NacosConfigRollbackRequest) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn get_rnacos_console_captcha(&self) -> Result<NacosRNacosConsoleCaptcha, String> {
            Err("unused".to_string())
        }
        async fn login_rnacos_console(&self, _: Option<String>) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn list_services(&self, _: NacosServiceQuery) -> Result<NacosServiceList, String> {
            Err("unused".to_string())
        }
        async fn list_instances(&self, _: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String> {
            Err("unused".to_string())
        }
        async fn update_instance(&self, _: NacosInstanceUpdate) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn raw_request(&self, _: NacosRawRequest) -> Result<NacosRawResponse, String> {
            Err("unused".to_string())
        }
    }

    fn config_item(index: usize, content: &str) -> NacosConfigItem {
        NacosConfigItem {
            data_id: format!("config-{index}"),
            group: "DEFAULT_GROUP".to_string(),
            namespace: "prod".to_string(),
            app_name: None,
            desc: None,
            tags: None,
            config_type: None,
            md5: None,
            encrypted_data_key: None,
            content: Some(content.to_string()),
        }
    }

    #[test]
    fn finds_literal_unicode_match_and_line() {
        let item = NacosConfigItem {
            data_id: "app.yaml".to_string(),
            group: "DEFAULT_GROUP".to_string(),
            namespace: "prod".to_string(),
            app_name: None,
            desc: None,
            tags: None,
            config_type: None,
            md5: None,
            encrypted_data_key: None,
            content: Some("第一行\n数据库地址: mysql://db\n最后".to_string()),
        };
        let found = find_first_match(&item, "mysql://").unwrap();
        assert_eq!(found.line_number, 2);
        assert_eq!(found.snippet, "数据库地址: mysql://db");
    }

    #[test]
    fn search_is_case_sensitive() {
        let item = NacosConfigItem {
            data_id: "app".to_string(),
            group: "g".to_string(),
            namespace: String::new(),
            app_name: None,
            desc: None,
            tags: None,
            config_type: None,
            md5: None,
            encrypted_data_key: None,
            content: Some("DatabaseURL".to_string()),
        };
        assert!(find_first_match(&item, "database").is_none());
    }

    #[test]
    fn long_line_snippet_keeps_the_match() {
        let query = "jdbc:mysql://important";
        let item = NacosConfigItem {
            data_id: "app".to_string(),
            group: "g".to_string(),
            namespace: String::new(),
            app_name: None,
            desc: None,
            tags: None,
            config_type: None,
            md5: None,
            encrypted_data_key: None,
            content: Some(format!("{}{}{}", "x".repeat(500), query, "y".repeat(500))),
        };
        let found = find_first_match(&item, query).unwrap();
        assert!(found.snippet.contains(query));
        assert!(found.snippet.starts_with('…'));
    }

    #[tokio::test]
    async fn fallback_search_scans_beyond_ten_pages() {
        let mut items: Vec<_> = (0..5_000).map(|index| config_item(index, "ordinary")).collect();
        items.push(config_item(5_000, "needle"));
        let admin = Arc::new(MockAdmin::new(items));
        let result = search_config_content(
            admin.clone(),
            NacosContentSearchRequest {
                operation_id: uuid::Uuid::new_v4().to_string(),
                namespace: Some("prod".to_string()),
                scope: NacosNamespaceScope::CurrentNamespace,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: None,
            },
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(result.scanned, 5_001);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 11);
    }

    #[tokio::test]
    async fn native_auth_error_does_not_trigger_full_scan() {
        let mut admin = MockAdmin::new(vec![config_item(0, "needle")]);
        admin.native_error = Some("NACOS_ERROR[authFailed]: 403".to_string());
        let admin = Arc::new(admin);
        let result = search_config_content(
            admin.clone(),
            NacosContentSearchRequest {
                operation_id: uuid::Uuid::new_v4().to_string(),
                namespace: Some("prod".to_string()),
                scope: NacosNamespaceScope::CurrentNamespace,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: None,
            },
            |_| {},
        )
        .await
        .unwrap();
        assert!(result.incomplete);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn repeated_fallback_page_stops_and_marks_results_incomplete() {
        let mut admin = MockAdmin::new(vec![config_item(0, "needle")]);
        admin.repeated_pages = true;
        admin.reported_total = Some(5_000);
        let admin = Arc::new(admin);
        let result = search_config_content(
            admin.clone(),
            NacosContentSearchRequest {
                operation_id: uuid::Uuid::new_v4().to_string(),
                namespace: Some("prod".to_string()),
                scope: NacosNamespaceScope::CurrentNamespace,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: None,
            },
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 2);
        assert_eq!(result.matches.len(), 1);
        assert!(result.incomplete);
        assert!(result.failures[0].error.contains("repeated a page"));
    }
}
