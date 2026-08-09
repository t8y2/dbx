use std::path::Path;
use std::sync::Arc;

use futures::{stream, StreamExt};
use sha2::{Digest, Sha256};

use crate::connection::AppState;
use crate::nacos::archive::{decode_config_archive, encode_config_archive, MAX_ARCHIVE_BYTES};
use crate::nacos::port::NacosAdmin;
use crate::nacos::search::{begin_operation, finish_operation};
use crate::nacos::service::{ensure_connection_writable, get_admin};
use crate::nacos::types::{
    NacosBatchItemResult, NacosBatchPreview, NacosBatchPreviewItem, NacosBatchReport, NacosConfigItem, NacosConfigKey,
    NacosConfigSelectionScope, NacosConfigSelector, NacosConfigTransferRequest, NacosConfigUpsert, NacosConflictPolicy,
};

const PAGE_SIZE: u32 = 500;
const DETAIL_CONCURRENCY: usize = 8;

pub async fn export_config_archive(
    admin: Arc<dyn NacosAdmin>,
    selector: NacosConfigSelector,
    destination: &Path,
) -> Result<NacosBatchReport, String> {
    let configs = resolve_selector(admin, &selector).await?;
    let (configs, bytes) = tokio::task::spawn_blocking(move || {
        let bytes = encode_config_archive(&configs)?;
        Ok::<_, String>((configs, bytes))
    })
    .await
    .map_err(|error| format!("Failed to encode Nacos configuration archive: {error}"))??;
    tokio::fs::write(destination, bytes)
        .await
        .map_err(|error| format!("Failed to write Nacos configuration archive {}: {error}", destination.display()))?;
    let items = configs
        .iter()
        .map(|config| NacosBatchItemResult {
            namespace: config.namespace.clone(),
            group: config.group.clone(),
            data_id: config.data_id.clone(),
            status: "exported".to_string(),
            message: None,
        })
        .collect();
    Ok(NacosBatchReport {
        operation_id: uuid::Uuid::new_v4().to_string(),
        plan_hash: None,
        total: configs.len() as u64,
        created: 0,
        overwritten: 0,
        skipped: 0,
        failed: 0,
        aborted: false,
        partial: false,
        cancelled: false,
        items,
    })
}

pub async fn preview_import(
    admin: Arc<dyn NacosAdmin>,
    target_namespace: &str,
    archive_path: &Path,
) -> Result<NacosBatchPreview, String> {
    let configs = read_archive(archive_path, target_namespace).await?;
    preview_configs(admin, &configs).await
}

pub async fn apply_import(
    admin: Arc<dyn NacosAdmin>,
    target_namespace: &str,
    archive_path: &Path,
    operation_id: &str,
    plan_hash: &str,
    policy: &NacosConflictPolicy,
) -> Result<NacosBatchReport, String> {
    let configs = read_archive(archive_path, target_namespace).await?;
    apply_configs(admin, configs, operation_id, plan_hash, policy).await
}

pub async fn preview_transfer(
    source_admin: Arc<dyn NacosAdmin>,
    target_admin: Arc<dyn NacosAdmin>,
    request: &NacosConfigTransferRequest,
) -> Result<NacosBatchPreview, String> {
    let configs = transfer_configs(source_admin, request).await?;
    preview_configs(target_admin, &configs).await
}

pub async fn apply_transfer(
    source_admin: Arc<dyn NacosAdmin>,
    target_admin: Arc<dyn NacosAdmin>,
    request: &NacosConfigTransferRequest,
    plan_hash: &str,
) -> Result<NacosBatchReport, String> {
    let configs = transfer_configs(source_admin, request).await?;
    apply_configs(target_admin, configs, &request.operation_id, plan_hash, &request.conflict_policy).await
}

pub async fn nacos_export_config_archive_core(
    state: &AppState,
    conn_id: &str,
    selector: NacosConfigSelector,
    destination: &Path,
) -> Result<NacosBatchReport, String> {
    let admin = get_admin(state, conn_id).await?;
    export_config_archive(admin, selector, destination).await
}

pub async fn nacos_preview_config_import_core(
    state: &AppState,
    conn_id: &str,
    target_namespace: &str,
    archive_path: &Path,
) -> Result<NacosBatchPreview, String> {
    ensure_connection_writable(state, conn_id, "Import Nacos configurations").await?;
    let admin = get_admin(state, conn_id).await?;
    preview_import(admin, target_namespace, archive_path).await
}

pub async fn nacos_apply_config_import_core(
    state: &AppState,
    conn_id: &str,
    target_namespace: &str,
    archive_path: &Path,
    operation_id: &str,
    plan_hash: &str,
    policy: &NacosConflictPolicy,
) -> Result<NacosBatchReport, String> {
    ensure_connection_writable(state, conn_id, "Import Nacos configurations").await?;
    let admin = get_admin(state, conn_id).await?;
    apply_import(admin, target_namespace, archive_path, operation_id, plan_hash, policy).await
}

pub async fn nacos_preview_config_transfer_core(
    state: &AppState,
    request: &NacosConfigTransferRequest,
) -> Result<NacosBatchPreview, String> {
    ensure_connection_writable(state, &request.target_connection_id, "Copy Nacos configurations").await?;
    let source_admin = get_admin(state, &request.source_connection_id).await?;
    let target_admin = get_admin(state, &request.target_connection_id).await?;
    preview_transfer(source_admin, target_admin, request).await
}

pub async fn nacos_apply_config_transfer_core(
    state: &AppState,
    request: &NacosConfigTransferRequest,
    plan_hash: &str,
) -> Result<NacosBatchReport, String> {
    ensure_connection_writable(state, &request.target_connection_id, "Copy Nacos configurations").await?;
    let source_admin = get_admin(state, &request.source_connection_id).await?;
    let target_admin = get_admin(state, &request.target_connection_id).await?;
    apply_transfer(source_admin, target_admin, request, plan_hash).await
}

async fn transfer_configs(
    source_admin: Arc<dyn NacosAdmin>,
    request: &NacosConfigTransferRequest,
) -> Result<Vec<NacosConfigUpsert>, String> {
    let source = resolve_selector(source_admin, &request.source).await?;
    source
        .into_iter()
        .map(|config| {
            let content = config
                .content
                .ok_or_else(|| format!("Nacos configuration {}/{} has no content", config.group, config.data_id))?;
            Ok(NacosConfigUpsert {
                namespace: Some(request.target_namespace.clone()),
                data_id: config.data_id,
                group: config.group,
                content,
                config_type: config.config_type,
                app_name: config.app_name,
                desc: config.desc,
                tags: config.tags,
            })
        })
        .collect()
}

async fn resolve_selector(
    admin: Arc<dyn NacosAdmin>,
    selector: &NacosConfigSelector,
) -> Result<Vec<NacosConfigItem>, String> {
    let keys = match selector.scope {
        NacosConfigSelectionScope::Selected => selector
            .keys
            .iter()
            .map(|key| NacosConfigKey {
                namespace: Some(selector.namespace.clone()),
                data_id: key.data_id.clone(),
                group: key.group.clone(),
            })
            .collect(),
        NacosConfigSelectionScope::Filtered | NacosConfigSelectionScope::Namespace => {
            let mut query = selector.query.clone().unwrap_or(crate::nacos::types::NacosConfigQuery {
                namespace: None,
                group: None,
                group_contains: false,
                data_id: None,
                app_name: None,
                search: None,
                page_no: None,
                page_size: None,
            });
            query.namespace = Some(selector.namespace.clone());
            if matches!(selector.scope, NacosConfigSelectionScope::Namespace) {
                query.group = None;
                query.data_id = None;
                query.app_name = None;
                query.search = None;
            }
            let mut keys = Vec::new();
            let mut seen = std::collections::HashSet::new();
            let mut page_no = 1;
            loop {
                query.page_no = Some(page_no);
                query.page_size = Some(PAGE_SIZE);
                let page = admin.list_configs(query.clone()).await?;
                let total = page.total_count;
                let empty = page.items.is_empty();
                let before = keys.len();
                keys.extend(page.items.into_iter().filter_map(|item| {
                    let key = NacosConfigKey {
                        namespace: Some(selector.namespace.clone()),
                        data_id: item.data_id,
                        group: item.group,
                    };
                    seen.insert((key.namespace.clone(), key.group.clone(), key.data_id.clone())).then_some(key)
                }));
                if empty || total == 0 || keys.len() as u64 >= total {
                    break;
                }
                if keys.len() == before {
                    return Err(
                        "Nacos configuration pagination made no progress; the server repeated a page".to_string()
                    );
                }
                page_no = page_no
                    .checked_add(1)
                    .ok_or_else(|| "Nacos configuration pagination exceeded the supported page range".to_string())?;
            }
            keys
        }
    };
    let mut seen = std::collections::HashSet::new();
    let keys: Vec<_> = keys
        .into_iter()
        .filter(|key| seen.insert((key.namespace.clone(), key.group.clone(), key.data_id.clone())))
        .collect();
    let details = stream::iter(keys)
        .map(|key| {
            let admin = admin.clone();
            async move { admin.get_config(key).await }
        })
        .buffer_unordered(DETAIL_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut configs = details.into_iter().collect::<Result<Vec<_>, _>>()?;
    configs.sort_by(|left, right| {
        (&left.namespace, &left.group, &left.data_id).cmp(&(&right.namespace, &right.group, &right.data_id))
    });
    Ok(configs)
}

async fn preview_configs(
    admin: Arc<dyn NacosAdmin>,
    configs: &[NacosConfigUpsert],
) -> Result<NacosBatchPreview, String> {
    let mut items = Vec::with_capacity(configs.len());
    let mut target_snapshots = Vec::with_capacity(configs.len());
    let mut created = 0;
    let mut conflicts = 0;
    for config in configs {
        let target = existing_config(admin.as_ref(), config).await?;
        let status = if target.is_some() {
            conflicts += 1;
            "conflict"
        } else {
            created += 1;
            "create"
        };
        target_snapshots.push(target);
        items.push(NacosBatchPreviewItem {
            namespace: config.namespace.clone().unwrap_or_default(),
            group: config.group.clone(),
            data_id: config.data_id.clone(),
            status: status.to_string(),
            message: None,
        });
    }
    Ok(NacosBatchPreview {
        plan_hash: plan_hash(configs, &target_snapshots),
        total: configs.len() as u64,
        created,
        conflicts,
        invalid: 0,
        items,
    })
}

async fn apply_configs(
    admin: Arc<dyn NacosAdmin>,
    configs: Vec<NacosConfigUpsert>,
    operation_id: &str,
    expected_plan_hash: &str,
    policy: &NacosConflictPolicy,
) -> Result<NacosBatchReport, String> {
    let preview = preview_configs(admin.clone(), &configs).await?;
    if preview.plan_hash != expected_plan_hash {
        return Err(
            "NACOS_ERROR[stalePreview]: Nacos import/copy preview is stale; preview again before applying".to_string()
        );
    }
    if matches!(policy, NacosConflictPolicy::Abort) && preview.conflicts > 0 {
        return Ok(NacosBatchReport {
            operation_id: operation_id.to_string(),
            plan_hash: Some(preview.plan_hash),
            total: configs.len() as u64,
            created: 0,
            overwritten: 0,
            skipped: configs.len() as u64,
            failed: 0,
            aborted: true,
            partial: false,
            cancelled: false,
            items: preview
                .items
                .into_iter()
                .map(|item| NacosBatchItemResult {
                    namespace: item.namespace,
                    group: item.group,
                    data_id: item.data_id,
                    status: "aborted".to_string(),
                    message: Some("Conflict policy ABORT prevented all writes".to_string()),
                })
                .collect(),
        });
    }
    let token = begin_operation(operation_id)?;
    struct Guard(String);
    impl Drop for Guard {
        fn drop(&mut self) {
            finish_operation(&self.0);
        }
    }
    let _guard = Guard(operation_id.to_string());
    let mut report = NacosBatchReport {
        operation_id: operation_id.to_string(),
        plan_hash: Some(preview.plan_hash),
        total: configs.len() as u64,
        created: 0,
        overwritten: 0,
        skipped: 0,
        failed: 0,
        aborted: false,
        partial: false,
        cancelled: false,
        items: Vec::with_capacity(configs.len()),
    };
    for (config, preview_item) in configs.into_iter().zip(preview.items) {
        if token.is_cancelled() {
            report.cancelled = true;
            break;
        }
        let conflict = preview_item.status == "conflict";
        if conflict && matches!(policy, NacosConflictPolicy::Skip) {
            report.skipped += 1;
            report.items.push(batch_result(&config, "skipped", None));
            continue;
        }
        match admin.publish_config(config.clone()).await {
            Ok(()) if conflict => {
                report.overwritten += 1;
                report.items.push(batch_result(&config, "overwritten", None));
            }
            Ok(()) => {
                report.created += 1;
                report.items.push(batch_result(&config, "created", None));
            }
            Err(error) => {
                report.failed += 1;
                report.items.push(batch_result(&config, "failed", Some(error)));
            }
        }
    }
    report.partial =
        report.cancelled || report.failed > 0 || report.created + report.overwritten + report.skipped < report.total;
    Ok(report)
}

async fn existing_config(
    admin: &dyn NacosAdmin,
    config: &NacosConfigUpsert,
) -> Result<Option<NacosConfigItem>, String> {
    let namespace = config.namespace.clone().unwrap_or_default();
    let page = admin
        .list_configs(crate::nacos::types::NacosConfigQuery {
            namespace: Some(namespace.clone()),
            group: Some(config.group.clone()),
            group_contains: false,
            data_id: Some(config.data_id.clone()),
            app_name: None,
            search: None,
            page_no: Some(1),
            page_size: Some(PAGE_SIZE),
        })
        .await?;
    let exists = page.items.iter().any(|item| item.group == config.group && item.data_id == config.data_id);
    if !exists {
        return Ok(None);
    }
    admin
        .get_config(NacosConfigKey {
            namespace: Some(namespace),
            data_id: config.data_id.clone(),
            group: config.group.clone(),
        })
        .await
        .map(Some)
}

fn plan_hash(configs: &[NacosConfigUpsert], targets: &[Option<NacosConfigItem>]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"dbx-nacos-batch-plan-v1");
    let mut entries = configs.iter().zip(targets.iter()).collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| {
        (left.namespace.as_deref().unwrap_or_default(), left.group.as_str(), left.data_id.as_str()).cmp(&(
            right.namespace.as_deref().unwrap_or_default(),
            right.group.as_str(),
            right.data_id.as_str(),
        ))
    });
    for (config, target) in entries {
        hash_field(&mut digest, config.namespace.as_deref().unwrap_or_default());
        hash_field(&mut digest, &config.group);
        hash_field(&mut digest, &config.data_id);
        hash_field(&mut digest, &config.content);
        hash_field(&mut digest, config.config_type.as_deref().unwrap_or_default());
        hash_field(&mut digest, config.app_name.as_deref().unwrap_or_default());
        hash_field(&mut digest, config.desc.as_deref().unwrap_or_default());
        hash_field(&mut digest, config.tags.as_deref().unwrap_or_default());
        if let Some(target) = target {
            digest.update([1]);
            hash_field(&mut digest, target.md5.as_deref().unwrap_or_default());
            hash_field(&mut digest, target.content.as_deref().unwrap_or_default());
        } else {
            digest.update([0]);
        }
    }
    digest.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash_field(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

fn batch_result(config: &NacosConfigUpsert, status: &str, message: Option<String>) -> NacosBatchItemResult {
    NacosBatchItemResult {
        namespace: config.namespace.clone().unwrap_or_default(),
        group: config.group.clone(),
        data_id: config.data_id.clone(),
        status: status.to_string(),
        message,
    }
}

async fn read_archive(path: &Path, target_namespace: &str) -> Result<Vec<NacosConfigUpsert>, String> {
    let path = path.to_path_buf();
    let target_namespace = target_namespace.to_string();
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("Failed to inspect Nacos archive {}: {error}", path.display()))?;
        if metadata.len() > MAX_ARCHIVE_BYTES {
            return Err("Nacos archive exceeds the 100 MiB limit".to_string());
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to read Nacos archive {}: {error}", path.display()))?;
        decode_config_archive(&bytes, &target_namespace)
    })
    .await
    .map_err(|error| format!("Failed to process Nacos configuration archive: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::RwLock;

    use async_trait::async_trait;

    use super::*;
    use crate::nacos::types::*;

    #[derive(Default)]
    struct MockAdmin {
        configs: RwLock<HashMap<(String, String, String), NacosConfigItem>>,
        failed_data_ids: RwLock<HashSet<String>>,
        publish_count: AtomicUsize,
    }

    impl MockAdmin {
        fn insert(&self, item: NacosConfigItem) {
            self.configs
                .write()
                .unwrap()
                .insert((item.namespace.clone(), item.group.clone(), item.data_id.clone()), item);
        }

        fn fail_publish(&self, data_id: &str) {
            self.failed_data_ids.write().unwrap().insert(data_id.to_string());
        }
    }

    #[async_trait]
    impl NacosAdmin for MockAdmin {
        async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
            Err("unused".to_string())
        }

        async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
            Err("unused".to_string())
        }

        async fn create_namespace(&self, _: NacosNamespaceCreate) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn update_namespace(&self, _: NacosNamespaceUpdate) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn list_configs(&self, query: NacosConfigQuery) -> Result<NacosConfigList, String> {
            let namespace = query.namespace.unwrap_or_default();
            let items: Vec<_> = self
                .configs
                .read()
                .unwrap()
                .values()
                .filter(|item| item.namespace == namespace)
                .filter(|item| query.group.as_ref().is_none_or(|group| item.group == *group))
                .filter(|item| query.data_id.as_ref().is_none_or(|data_id| item.data_id == *data_id))
                .cloned()
                .collect();
            Ok(NacosConfigList {
                page_no: query.page_no.unwrap_or(1),
                page_size: query.page_size.unwrap_or(PAGE_SIZE),
                total_count: items.len() as u64,
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
            Err("unused".to_string())
        }

        async fn get_config(&self, key: NacosConfigKey) -> Result<NacosConfigItem, String> {
            self.configs
                .read()
                .unwrap()
                .get(&(key.namespace.unwrap_or_default(), key.group, key.data_id))
                .cloned()
                .ok_or_else(|| "not found".to_string())
        }

        async fn publish_config(&self, req: NacosConfigUpsert) -> Result<(), String> {
            if self.failed_data_ids.read().unwrap().contains(&req.data_id) {
                return Err("simulated publish failure".to_string());
            }
            self.publish_count.fetch_add(1, Ordering::SeqCst);
            let namespace = req.namespace.unwrap_or_default();
            self.insert(NacosConfigItem {
                data_id: req.data_id,
                group: req.group,
                namespace,
                app_name: req.app_name,
                desc: req.desc,
                tags: req.tags,
                config_type: req.config_type,
                md5: None,
                encrypted_data_key: None,
                content: Some(req.content),
            });
            Ok(())
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

        async fn get_service(&self, _: NacosServiceQuery) -> Result<NacosServiceDetail, String> {
            Err("unused".to_string())
        }
        async fn create_service(&self, _: NacosServiceUpsert) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn update_service(&self, _: NacosServiceUpsert) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn delete_service(&self, _: NacosServiceQuery) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn list_instances(&self, _: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String> {
            Err("unused".to_string())
        }

        async fn update_instance(&self, _: NacosInstanceUpdateRequest) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn register_instance(&self, _: NacosInstanceRegistration) -> Result<(), String> {
            Err("unused".to_string())
        }
        async fn deregister_instance(&self, _: NacosInstanceRef) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn get_dashboard(&self, _: NacosDashboardQuery) -> Result<NacosDashboardSnapshot, String> {
            Err("unused".to_string())
        }

        async fn raw_request(&self, _: NacosRawRequest) -> Result<NacosRawResponse, String> {
            Err("unused".to_string())
        }
    }

    fn upsert(data_id: &str, content: &str) -> NacosConfigUpsert {
        NacosConfigUpsert {
            namespace: Some("target".to_string()),
            data_id: data_id.to_string(),
            group: "DEFAULT_GROUP".to_string(),
            content: content.to_string(),
            config_type: Some("text".to_string()),
            app_name: None,
            desc: None,
            tags: None,
        }
    }

    fn existing(data_id: &str, content: &str) -> NacosConfigItem {
        NacosConfigItem {
            data_id: data_id.to_string(),
            group: "DEFAULT_GROUP".to_string(),
            namespace: "target".to_string(),
            app_name: None,
            desc: None,
            tags: None,
            config_type: Some("text".to_string()),
            md5: Some(format!("md5-{content}")),
            encrypted_data_key: None,
            content: Some(content.to_string()),
        }
    }

    async fn preview_hash(admin: Arc<MockAdmin>, configs: &[NacosConfigUpsert]) -> String {
        preview_configs(admin, configs).await.unwrap().plan_hash
    }

    #[tokio::test]
    async fn stale_preview_is_rejected_before_any_publish() {
        let admin = Arc::new(MockAdmin::default());
        let configs = vec![upsert("app", "new")];
        let hash = preview_hash(admin.clone(), &configs).await;
        admin.insert(existing("app", "concurrent"));

        let error = apply_configs(
            admin.clone(),
            configs,
            &uuid::Uuid::new_v4().to_string(),
            &hash,
            &NacosConflictPolicy::Overwrite,
        )
        .await
        .unwrap_err();

        assert!(error.contains("stalePreview"));
        assert_eq!(admin.publish_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn apply_accepts_preview_when_concurrent_source_reads_complete_in_another_order() {
        let admin = Arc::new(MockAdmin::default());
        let preview_configs = vec![upsert("first", "one"), upsert("second", "two")];
        let hash = preview_hash(admin.clone(), &preview_configs).await;

        // `resolve_selector` fetches details concurrently, so the same selected
        // configurations can reach apply in a different completion order.
        let apply_configs_in_completion_order = vec![upsert("second", "two"), upsert("first", "one")];
        let report = apply_configs(
            admin.clone(),
            apply_configs_in_completion_order,
            &uuid::Uuid::new_v4().to_string(),
            &hash,
            &NacosConflictPolicy::Overwrite,
        )
        .await
        .unwrap();

        assert_eq!(report.created, 2);
        assert_eq!(admin.publish_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn abort_policy_writes_nothing_when_any_conflict_exists() {
        let admin = Arc::new(MockAdmin::default());
        admin.insert(existing("conflict", "old"));
        let configs = vec![upsert("conflict", "new"), upsert("fresh", "value")];
        let hash = preview_hash(admin.clone(), &configs).await;

        let report = apply_configs(
            admin.clone(),
            configs,
            &uuid::Uuid::new_v4().to_string(),
            &hash,
            &NacosConflictPolicy::Abort,
        )
        .await
        .unwrap();

        assert!(report.aborted);
        assert_eq!(report.skipped, 2);
        assert_eq!(admin.publish_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn skip_and_overwrite_policies_report_per_item_outcomes() {
        let skip_admin = Arc::new(MockAdmin::default());
        skip_admin.insert(existing("conflict", "old"));
        let configs = vec![upsert("conflict", "new"), upsert("fresh", "value")];
        let skip_hash = preview_hash(skip_admin.clone(), &configs).await;
        let skipped = apply_configs(
            skip_admin.clone(),
            configs.clone(),
            &uuid::Uuid::new_v4().to_string(),
            &skip_hash,
            &NacosConflictPolicy::Skip,
        )
        .await
        .unwrap();
        assert_eq!((skipped.created, skipped.skipped, skipped.overwritten), (1, 1, 0));
        assert_eq!(skip_admin.publish_count.load(Ordering::SeqCst), 1);

        let overwrite_admin = Arc::new(MockAdmin::default());
        overwrite_admin.insert(existing("conflict", "old"));
        let overwrite_hash = preview_hash(overwrite_admin.clone(), &configs).await;
        let overwritten = apply_configs(
            overwrite_admin.clone(),
            configs,
            &uuid::Uuid::new_v4().to_string(),
            &overwrite_hash,
            &NacosConflictPolicy::Overwrite,
        )
        .await
        .unwrap();
        assert_eq!((overwritten.created, overwritten.skipped, overwritten.overwritten), (1, 0, 1));
        assert_eq!(overwrite_admin.publish_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn publish_failure_keeps_successes_and_marks_report_partial() {
        let admin = Arc::new(MockAdmin::default());
        admin.fail_publish("bad");
        let configs = vec![upsert("good", "value"), upsert("bad", "value")];
        let hash = preview_hash(admin.clone(), &configs).await;

        let report = apply_configs(
            admin.clone(),
            configs,
            &uuid::Uuid::new_v4().to_string(),
            &hash,
            &NacosConflictPolicy::Overwrite,
        )
        .await
        .unwrap();

        assert_eq!((report.created, report.failed), (1, 1));
        assert!(report.partial);
        assert_eq!(admin.publish_count.load(Ordering::SeqCst), 1);
    }
}
