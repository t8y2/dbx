use std::collections::{HashMap, HashSet};
use std::future::Future;
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
    let Some(token) = operations.get(operation_id.trim()) else {
        return false;
    };
    token.cancel();
    true
}

pub(crate) fn finish_operation(operation_id: &str) {
    if let Ok(mut operations) = operations().lock() {
        operations.remove(operation_id.trim());
    }
}

struct OperationGuard(String);

impl Drop for OperationGuard {
    fn drop(&mut self) {
        finish_operation(&self.0);
    }
}

pub async fn search_config_content<F, Fut>(
    admin: Arc<dyn NacosAdmin>,
    mut request: NacosContentSearchRequest,
    on_progress: F,
) -> Result<NacosContentSearchResult, String>
where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
{
    let query = request.query.clone();
    if query.is_empty() {
        return Err("Nacos configuration content search query is required".to_string());
    }
    if query.chars().count() > 1_024 {
        return Err("Nacos configuration content search query exceeds the 1024 character limit".to_string());
    }
    request.operation_id = request.operation_id.trim().to_string();
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
        let namespace_result = search_namespace(
            &admin,
            &namespace,
            &request,
            &query,
            literal_requires_scan,
            result_limit,
            &token,
            &on_progress,
            &mut result,
            &mut pending_matches,
        )
        .await;
        match namespace_result {
            Ok(Some(error)) => {
                result.failures.push(NacosSearchFailure { namespace: namespace.clone(), error });
                result.incomplete = true;
            }
            Ok(None) => {}
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
                )
                .await;
                continue;
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
    )
    .await;
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

#[allow(clippy::too_many_arguments)]
async fn search_namespace<F, Fut>(
    admin: &Arc<dyn NacosAdmin>,
    namespace: &str,
    request: &NacosContentSearchRequest,
    query: &str,
    literal_requires_scan: bool,
    result_limit: usize,
    token: &CancellationToken,
    on_progress: &F,
    result: &mut NacosContentSearchResult,
    pending_matches: &mut Vec<NacosContentMatch>,
) -> Result<Option<String>, String>
where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
{
    if literal_requires_scan {
        return search_enumerated_pages(
            admin,
            namespace,
            request,
            query,
            result_limit,
            token,
            on_progress,
            result,
            pending_matches,
        )
        .await;
    }
    let first = admin.search_config_content_page(namespace, query, 1, SEARCH_PAGE_SIZE).await?;
    let Some(first) = first else {
        return search_enumerated_pages(
            admin,
            namespace,
            request,
            query,
            result_limit,
            token,
            on_progress,
            result,
            pending_matches,
        )
        .await;
    };
    search_native_pages(
        admin,
        namespace,
        request,
        query,
        first,
        result_limit,
        token,
        on_progress,
        result,
        pending_matches,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn search_native_pages<F, Fut>(
    admin: &Arc<dyn NacosAdmin>,
    namespace: &str,
    request: &NacosContentSearchRequest,
    query: &str,
    first: crate::nacos::types::NacosConfigList,
    result_limit: usize,
    token: &CancellationToken,
    on_progress: &F,
    result: &mut NacosContentSearchResult,
    pending_matches: &mut Vec<NacosContentMatch>,
) -> Result<Option<String>, String>
where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
{
    let total = first.total_count;
    let mut page = first;
    let mut next_page_no = 2u32;
    let mut seen = HashSet::new();
    loop {
        if token.is_cancelled() || result.matches.len() >= result_limit {
            break;
        }
        let empty = page.items.is_empty();
        let before = seen.len();
        let candidates = page
            .items
            .into_iter()
            .filter(|item| seen.insert((item.namespace.clone(), item.group.clone(), item.data_id.clone())))
            .collect();
        emit_candidate_progress(on_progress, request, namespace, result, seen.len() as u64, Some(total)).await;
        process_candidate_page(
            admin,
            namespace,
            request,
            query,
            candidates,
            result_limit,
            token,
            on_progress,
            result,
            pending_matches,
        )
        .await;
        if token.is_cancelled() || result.matches.len() >= result_limit {
            break;
        }
        if empty || total == 0 || seen.len() as u64 >= total {
            break;
        }
        if seen.len() == before {
            return Ok(Some("Nacos content-search pagination stopped because the server repeated a page".to_string()));
        }
        let page_no = next_page_no;
        next_page_no = match next_page_no.checked_add(1) {
            Some(next) => next,
            None => {
                return Ok(Some("Nacos content-search pagination exceeded the supported page range".to_string()));
            }
        };
        let Some(next_page) = admin.search_config_content_page(namespace, query, page_no, SEARCH_PAGE_SIZE).await?
        else {
            return Err("Nacos native content-search endpoint became unavailable during pagination".to_string());
        };
        page = next_page;
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
async fn search_enumerated_pages<F, Fut>(
    admin: &Arc<dyn NacosAdmin>,
    namespace: &str,
    request: &NacosContentSearchRequest,
    query: &str,
    result_limit: usize,
    token: &CancellationToken,
    on_progress: &F,
    result: &mut NacosContentSearchResult,
    pending_matches: &mut Vec<NacosContentMatch>,
) -> Result<Option<String>, String>
where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
{
    let mut page_no = 1u32;
    let mut seen = HashSet::new();
    loop {
        if token.is_cancelled() || result.matches.len() >= result_limit {
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
        let before = seen.len();
        let candidates = page
            .items
            .into_iter()
            .filter(|item| seen.insert((item.namespace.clone(), item.group.clone(), item.data_id.clone())))
            .collect();
        emit_candidate_progress(on_progress, request, namespace, result, seen.len() as u64, Some(total)).await;
        process_candidate_page(
            admin,
            namespace,
            request,
            query,
            candidates,
            result_limit,
            token,
            on_progress,
            result,
            pending_matches,
        )
        .await;
        if token.is_cancelled() || result.matches.len() >= result_limit {
            break;
        }
        if empty || total == 0 || seen.len() as u64 >= total {
            break;
        }
        if seen.len() == before {
            return Ok(Some("Nacos configuration pagination stopped because the server repeated a page".to_string()));
        }
        page_no = match page_no.checked_add(1) {
            Some(next) => next,
            None => {
                return Ok(Some("Nacos configuration pagination exceeded the supported page range".to_string()));
            }
        };
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
async fn process_candidate_page<F, Fut>(
    admin: &Arc<dyn NacosAdmin>,
    namespace: &str,
    request: &NacosContentSearchRequest,
    query: &str,
    candidates: Vec<NacosConfigItem>,
    result_limit: usize,
    token: &CancellationToken,
    on_progress: &F,
    result: &mut NacosContentSearchResult,
    pending_matches: &mut Vec<NacosContentMatch>,
) where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
{
    let remaining_results = result_limit.saturating_sub(result.matches.len());
    if remaining_results == 0 {
        return;
    }
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
            let key =
                NacosConfigKey { namespace: Some(item.namespace.clone()), data_id: item.data_id, group: item.group };
            Some((key.clone(), admin.get_config(key).await))
        }
    })
    .buffer_unordered(SEARCH_CONCURRENCY.min(remaining_results));
    futures::pin_mut!(details);

    loop {
        if token.is_cancelled() || result.matches.len() >= result_limit {
            break;
        }
        let Some(detail) = details.next().await else {
            break;
        };
        let Some((key, detail)) = detail else {
            continue;
        };
        result.scanned += 1;
        match detail {
            Ok(item) => {
                if let Some(content_match) = find_first_match(&item, query) {
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
                on_progress,
                &request.operation_id,
                "searching",
                Some(namespace.to_string()),
                result,
                std::mem::take(pending_matches),
                false,
            )
            .await;
        }
    }
}

async fn emit_candidate_progress<F, Fut>(
    on_progress: &F,
    request: &NacosContentSearchRequest,
    namespace: &str,
    result: &NacosContentSearchResult,
    enumerated: u64,
    total: Option<u64>,
) where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
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
    })
    .await;
}

async fn emit_progress<F, Fut>(
    on_progress: &F,
    operation_id: &str,
    phase: &str,
    namespace: Option<String>,
    result: &NacosContentSearchResult,
    matches: Vec<NacosContentMatch>,
    done: bool,
) where
    F: Fn(NacosSearchProgress) -> Fut + Send + Sync,
    Fut: Future<Output = ()> + Send,
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
    })
    .await;
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
        native_items: Option<Vec<NacosConfigItem>>,
        native_calls: AtomicUsize,
        list_calls: AtomicUsize,
        detail_calls: AtomicUsize,
        repeated_pages: bool,
        reported_total: Option<u64>,
        pending_details: bool,
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
                native_items: None,
                native_calls: AtomicUsize::new(0),
                list_calls: AtomicUsize::new(0),
                detail_calls: AtomicUsize::new(0),
                repeated_pages: false,
                reported_total: None,
                pending_details: false,
            }
        }
    }

    #[async_trait]
    impl NacosAdmin for MockAdmin {
        async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
            Err("unused".to_string())
        }
        async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
            let mut seen = HashSet::new();
            Ok(self
                .ordered
                .iter()
                .filter_map(|item| {
                    seen.insert(item.namespace.clone()).then(|| NacosNamespaceInfo {
                        namespace: item.namespace.clone(),
                        namespace_show_name: item.namespace.clone(),
                        namespace_desc: None,
                        config_count: None,
                        quota: None,
                        namespace_type: None,
                    })
                })
                .collect())
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
            let filtered: Vec<_> = self
                .ordered
                .iter()
                .filter(|item| query.namespace.as_deref().is_none_or(|namespace| item.namespace == namespace))
                .filter(|item| {
                    query
                        .group
                        .as_deref()
                        .map(str::trim)
                        .filter(|group| !group.is_empty())
                        .is_none_or(|group| item.group.contains(group))
                })
                .cloned()
                .collect();
            let start = if self.repeated_pages { 0 } else { ((page_no - 1) * page_size) as usize };
            let end = (start + page_size as usize).min(filtered.len());
            let items = if start < filtered.len() { filtered[start..end].to_vec() } else { Vec::new() };
            Ok(NacosConfigList {
                page_no,
                page_size,
                total_count: self.reported_total.unwrap_or(filtered.len() as u64),
                items,
            })
        }
        async fn search_config_content_page(
            &self,
            namespace: &str,
            _: &str,
            page_no: u32,
            page_size: u32,
        ) -> Result<Option<NacosConfigList>, String> {
            self.native_calls.fetch_add(1, Ordering::SeqCst);
            match &self.native_error {
                Some(error) => Err(error.clone()),
                None => {
                    let Some(native_items) = &self.native_items else {
                        return Ok(None);
                    };
                    let filtered: Vec<_> =
                        native_items.iter().filter(|item| item.namespace == namespace).cloned().collect();
                    let start = ((page_no - 1) * page_size) as usize;
                    let end = (start + page_size as usize).min(filtered.len());
                    let items = if start < filtered.len() { filtered[start..end].to_vec() } else { Vec::new() };
                    Ok(Some(NacosConfigList { page_no, page_size, total_count: filtered.len() as u64, items }))
                }
            }
        }
        async fn get_config(&self, key: NacosConfigKey) -> Result<NacosConfigItem, String> {
            self.detail_calls.fetch_add(1, Ordering::SeqCst);
            if self.pending_details {
                std::future::pending::<()>().await;
            }
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
        async fn get_dashboard(&self, _: NacosDashboardQuery) -> Result<NacosDashboardSnapshot, String> {
            Err("unused".to_string())
        }
        async fn raw_request(&self, _: NacosRawRequest) -> Result<NacosRawResponse, String> {
            Err("unused".to_string())
        }
    }

    fn config_item(index: usize, content: &str) -> NacosConfigItem {
        config_item_in_namespace(index, "prod", content)
    }

    fn config_item_in_namespace(index: usize, namespace: &str, content: &str) -> NacosConfigItem {
        NacosConfigItem {
            data_id: format!("config-{index}"),
            group: "DEFAULT_GROUP".to_string(),
            namespace: namespace.to_string(),
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

    #[test]
    fn operation_registry_normalizes_ids_for_cancel_and_cleanup() {
        let operation_id = format!("whitespace-{}", uuid::Uuid::new_v4());
        let token = begin_operation(&format!(" \t{operation_id}\n")).unwrap();

        assert!(cancel_operation(&format!("\n{operation_id} ")));
        assert!(token.is_cancelled());
        finish_operation(&format!(" {operation_id}\t"));
        assert!(!cancel_operation(&operation_id));
    }

    #[tokio::test]
    async fn search_uses_the_normalized_operation_id_everywhere() {
        let operation_id = format!("normalized-{}", uuid::Uuid::new_v4());
        let progress_ids = Arc::new(Mutex::new(Vec::new()));
        let captured_progress_ids = progress_ids.clone();
        let result = search_config_content(
            Arc::new(MockAdmin::new(vec![config_item(0, "needle")])),
            NacosContentSearchRequest {
                operation_id: format!(" \t{operation_id}\n"),
                namespace: Some("prod".to_string()),
                scope: NacosNamespaceScope::CurrentNamespace,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: Some(10),
            },
            move |progress| {
                let captured_progress_ids = captured_progress_ids.clone();
                async move {
                    captured_progress_ids.lock().unwrap().push(progress.operation_id);
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(result.operation_id, operation_id);
        assert!(progress_ids.lock().unwrap().iter().all(|value| value == &operation_id));
        assert!(!cancel_operation(&operation_id));
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
                max_results: Some(1),
            },
            |_| std::future::ready(()),
        )
        .await
        .unwrap();
        assert_eq!(result.scanned, 5_001);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 11);
    }

    #[tokio::test]
    async fn fallback_search_stops_before_the_next_page_when_the_result_budget_is_exhausted() {
        let items: Vec<_> = (0..1_000).map(|index| config_item(index, "needle")).collect();
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
                max_results: Some(1),
            },
            |_| std::future::ready(()),
        )
        .await
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert!(result.truncated);
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.detail_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn native_search_stops_before_the_next_page_when_the_result_budget_is_exhausted() {
        let items: Vec<_> = (0..1_000).map(|index| config_item(index, "needle")).collect();
        let mut mock = MockAdmin::new(items.clone());
        mock.native_items = Some(items);
        let admin = Arc::new(mock);
        let result = search_config_content(
            admin.clone(),
            NacosContentSearchRequest {
                operation_id: uuid::Uuid::new_v4().to_string(),
                namespace: Some("prod".to_string()),
                scope: NacosNamespaceScope::CurrentNamespace,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: Some(1),
            },
            |_| std::future::ready(()),
        )
        .await
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert!(result.truncated);
        assert_eq!(admin.native_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.detail_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn all_namespace_search_stops_before_opening_the_next_namespace() {
        let mut items = vec![config_item_in_namespace(0, "prod", "needle")];
        items.extend((1..=500).map(|index| config_item_in_namespace(index, "staging", "needle")));
        let admin = Arc::new(MockAdmin::new(items));
        let result = search_config_content(
            admin.clone(),
            NacosContentSearchRequest {
                operation_id: uuid::Uuid::new_v4().to_string(),
                namespace: None,
                scope: NacosNamespaceScope::AllNamespaces,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: Some(1),
            },
            |_| std::future::ready(()),
        )
        .await
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].namespace, "prod");
        assert_eq!(admin.native_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dropping_a_running_search_cleans_the_operation_registry() {
        let operation_id = format!("drop-{}", uuid::Uuid::new_v4());
        let mut mock = MockAdmin::new(vec![config_item(0, "needle")]);
        mock.pending_details = true;
        let mut search = Box::pin(search_config_content(
            Arc::new(mock),
            NacosContentSearchRequest {
                operation_id: operation_id.clone(),
                namespace: Some("prod".to_string()),
                scope: NacosNamespaceScope::CurrentNamespace,
                query: "needle".to_string(),
                group: None,
                data_id: None,
                max_results: Some(1),
            },
            |_| std::future::ready(()),
        ));

        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), search.as_mut()).await.is_err());
        assert!(cancel_operation(&operation_id));
        drop(search);
        assert!(!cancel_operation(&operation_id));
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
            |_| std::future::ready(()),
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
            |_| std::future::ready(()),
        )
        .await
        .unwrap();
        assert_eq!(admin.list_calls.load(Ordering::SeqCst), 2);
        assert_eq!(result.matches.len(), 1);
        assert!(result.incomplete);
        assert!(result.failures[0].error.contains("repeated a page"));
    }
}
