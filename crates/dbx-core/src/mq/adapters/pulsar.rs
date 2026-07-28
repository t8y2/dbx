//! Apache Pulsar admin adapter. Talks to the Pulsar Admin REST API directly via
//! `reqwest` (no heavyweight Pulsar client dependency). All version-specific
//! endpoint construction and response parsing is delegated to
//! [`PulsarApiProfile`], so the adapter body stays version-agnostic.

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures::{stream, StreamExt};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

use super::pulsar_version::{DetectedVersion, PulsarApiProfile, PulsarVersion, VersionDetection};
use crate::mq::auth::{MqAuth, TokenCache};
use crate::mq::config::{MqAdminConfig, MqConnectOverride};
use crate::mq::port::MessageQueueAdmin;
use crate::mq::types::*;
use crate::mq::util::truncate;

/// How long to wait for a single admin REST call.
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// How long to wait for the initial version-probe during construction.
const PROBE_TIMEOUT_SECS: u64 = 8;
const DETAIL_REQUEST_CONCURRENCY: usize = 8;
const PARTITION_METADATA_CONCURRENCY: usize = 8;
const PEEK_REQUEST_CONCURRENCY: usize = 4;
/// Maximum response body size for raw requests (10 MB).
const MAX_RAW_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

pub struct PulsarAdmin {
    base: String,
    http: reqwest::Client,
    auth: MqAuth,
    token_cache: TokenCache,
    profile: PulsarApiProfile,
}

impl PulsarAdmin {
    /// Build an adapter, probing the broker version (unless pinned) to resolve
    /// the API profile. Probe failure degrades gracefully to the 3.1.x baseline.
    pub async fn new(cfg: MqAdminConfig) -> Result<Self, String> {
        let base = normalize_base(&cfg.admin_url);
        let http = build_http_client(cfg.tls_skip_verify, cfg.connect_override.as_ref(), &cfg.admin_url)?;
        let auth = cfg.auth.clone();
        let token_cache = TokenCache::default();

        let detected = detect_version(&http, &base, &auth, &token_cache, cfg.pinned_version.as_deref()).await;
        let profile = PulsarApiProfile::resolve(detected);

        log::info!(
            "Pulsar admin connected to {} (version profile {}, detection {})",
            redact_base(&base),
            profile.label(),
            profile.detection().as_str()
        );

        Ok(Self { base, http, auth, token_cache, profile })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Issue a request, applying auth, and return the raw response.
    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&serde_json::Value>,
        query: Option<&[(String, String)]>,
    ) -> Result<reqwest::Response, String> {
        let mut req = self.http.request(method.clone(), self.url(path));
        if let Some(q) = query {
            req = req.query(q);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        req = self.auth.apply(req, &self.http, &self.token_cache).await?;
        req.send().await.map_err(|e| format!("Pulsar admin request to {path} failed: {e}"))
    }

    /// GET a path and deserialize the JSON body into `T`.
    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let resp = self.send(reqwest::Method::GET, path, None, None).await?;
        let resp = error_for_status(resp, path).await?;
        resp.json::<T>().await.map_err(|e| format!("Failed to parse response from {path}: {e}"))
    }

    /// GET a path and return the parsed JSON value.
    async fn get_value(&self, path: &str) -> Result<serde_json::Value, String> {
        self.get_json::<serde_json::Value>(path).await
    }

    /// GET an optional policy endpoint. Pulsar returns 404/405/204 or an empty
    /// body for some unset or unsupported scoped policies; those should not make
    /// the whole policy panel fail.
    async fn get_optional_value(&self, path: &str) -> Result<Option<serde_json::Value>, String> {
        let resp = self.send(reqwest::Method::GET, path, None, None).await?;
        let status = resp.status();
        if matches!(
            status,
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED | reqwest::StatusCode::NO_CONTENT
        ) {
            return Ok(None);
        }
        let resp = error_for_status(resp, path).await?;
        let body = resp.text().await.map_err(|e| format!("Failed to read response from {path}: {e}"))?;
        let body = body.trim();
        if body.is_empty() {
            return Ok(None);
        }
        serde_json::from_str(body).map(Some).map_err(|e| format!("Failed to parse response from {path}: {e}"))
    }

    /// Send a mutating request that returns no meaningful body.
    async fn send_empty(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&serde_json::Value>,
        query: Option<&[(String, String)]>,
    ) -> Result<(), String> {
        let resp = self.send(method, path, body, query).await?;
        error_for_status(resp, path).await?;
        Ok(())
    }

    async fn namespace_admin_roles(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, String> {
        let path = self.profile.namespace_permissions_path(tenant, namespace);
        let raw: serde_json::Value = self.get_value(&path).await?;
        let mut roles = raw.as_object().map(|obj| obj.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
        roles.sort();
        Ok(roles)
    }
}

#[async_trait]
impl MessageQueueAdmin for PulsarAdmin {
    fn capabilities(&self) -> MqCapabilities {
        self.profile.capabilities()
    }

    fn system_kind(&self) -> MqSystemKind {
        MqSystemKind::Pulsar
    }

    async fn test_connection(&self) -> Result<MqClusterInfo, String> {
        // Verify reachability and authorization by listing clusters.
        let clusters = self.get_value(&self.profile.clusters_path()).await?;
        Ok(MqClusterInfo {
            system_kind: MqSystemKind::Pulsar,
            server_version: self.profile.raw_version().map(str::to_string),
            resolved_profile: self.profile.label().to_string(),
            version_detection: self.profile.detection().as_str().to_string(),
            capabilities: self.profile.capabilities(),
            extra: serde_json::json!({ "clusters": clusters }),
        })
    }

    // ---- Tenants ----

    async fn list_tenants(&self) -> Result<Vec<TenantInfo>, String> {
        let names: Vec<String> = self.get_json(&self.profile.tenants_path()).await?;
        stream::iter(names)
            .map(|name| async move {
                match self.get_tenant(&name).await {
                    Ok(tenant) => Ok(tenant),
                    Err(err) if is_unsupported_endpoint_error(&err) => {
                        log::debug!("Pulsar tenant detail unavailable for '{}': {}", name, err);
                        Ok(TenantInfo { name, ..Default::default() })
                    }
                    Err(err) => Err(err),
                }
            })
            .buffered(DETAIL_REQUEST_CONCURRENCY)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect()
    }

    async fn get_tenant(&self, name: &str) -> Result<TenantInfo, String> {
        let raw = self.get_value(&self.profile.tenant_path(name)).await?;
        Ok(TenantInfo {
            name: name.to_string(),
            admin_roles: string_array(&raw, "adminRoles"),
            allowed_clusters: string_array(&raw, "allowedClusters"),
        })
    }

    async fn create_tenant(&self, name: &str, cfg: TenantConfig) -> Result<(), String> {
        let body = serde_json::json!({
            "adminRoles": cfg.admin_roles,
            "allowedClusters": cfg.allowed_clusters,
        });
        self.send_empty(reqwest::Method::PUT, &self.profile.tenant_path(name), Some(&body), None).await
    }

    async fn update_tenant(&self, name: &str, cfg: TenantConfig) -> Result<(), String> {
        let body = serde_json::json!({
            "adminRoles": cfg.admin_roles,
            "allowedClusters": cfg.allowed_clusters,
        });
        self.send_empty(reqwest::Method::POST, &self.profile.tenant_path(name), Some(&body), None).await
    }

    async fn delete_tenant(&self, name: &str, force: bool) -> Result<(), String> {
        let query = force_query(force);
        self.send_empty(reqwest::Method::DELETE, &self.profile.tenant_path(name), None, query.as_deref()).await
    }

    // ---- Namespaces ----

    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<NamespaceInfo>, String> {
        // Returns fully-qualified `tenant/namespace` strings.
        let names: Vec<String> = self.get_json(&self.profile.namespaces_path(tenant)).await?;
        stream::iter(names)
            .map(|full| async move {
                let namespace = full.rsplit('/').next().unwrap_or(&full).to_string();
                let admin_roles = match self.namespace_admin_roles(tenant, &namespace).await {
                    Ok(roles) => roles,
                    Err(err) if is_unsupported_endpoint_error(&err) => {
                        log::debug!("Pulsar namespace roles unavailable for '{}': {}", full, err);
                        Vec::new()
                    }
                    Err(err) => return Err(err),
                };
                Ok(NamespaceInfo { tenant: tenant.to_string(), namespace, admin_roles })
            })
            .buffered(DETAIL_REQUEST_CONCURRENCY)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect()
    }

    async fn create_namespace(&self, ns: &NamespaceRef, cfg: NamespaceConfig) -> Result<(), String> {
        let path = self.profile.namespace_path(&ns.tenant, &ns.namespace);
        // An empty body creates a namespace with defaults; provide a policies
        // object when clusters/bundles are specified.
        let body = if cfg.clusters.is_empty() && cfg.bundles.is_none() {
            None
        } else {
            let mut obj = serde_json::Map::new();
            if !cfg.clusters.is_empty() {
                obj.insert("replication_clusters".to_string(), serde_json::json!(cfg.clusters));
            }
            if let Some(bundles) = cfg.bundles {
                obj.insert("bundles".to_string(), serde_json::json!({ "numBundles": bundles }));
            }
            Some(serde_json::Value::Object(obj))
        };
        self.send_empty(reqwest::Method::PUT, &path, body.as_ref(), None).await
    }

    async fn delete_namespace(&self, ns: &NamespaceRef, force: bool) -> Result<(), String> {
        let path = self.profile.namespace_path(&ns.tenant, &ns.namespace);
        let query = force_query(force);
        self.send_empty(reqwest::Method::DELETE, &path, None, query.as_deref()).await
    }

    async fn get_namespace_policies(&self, ns: &NamespaceRef) -> Result<serde_json::Value, String> {
        self.get_value(&self.profile.namespace_policies_path(&ns.tenant, &ns.namespace)).await
    }

    // ---- Topics ----

    async fn list_topics(&self, ns: &NamespaceRef, opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String> {
        let mut topics: Vec<TopicInfo> = Vec::new();
        let mut domains = vec![true];
        if opts.include_non_persistent {
            domains.push(false);
        }

        for persistent in domains {
            // Partitioned topics first, so we can mark them and avoid double-listing.
            let partitioned_path = self.profile.partitioned_topics_path(&ns.tenant, &ns.namespace, persistent);
            let partitioned: Vec<String> = match self.get_json(&partitioned_path).await {
                Ok(partitioned) => partitioned,
                Err(err) if is_unsupported_endpoint_error(&err) => Vec::new(),
                Err(err) => return Err(err),
            };
            let partitioned_set: std::collections::HashSet<String> = partitioned.iter().cloned().collect();
            let domain = if persistent { "persistent" } else { "non-persistent" };
            let partitioned_topics = stream::iter(partitioned)
                .map(|full| async move {
                    let partitions = self.partition_count_for_topic(domain, &full).await?;
                    Ok::<_, String>(TopicInfo {
                        short_name: short_topic_name(&full),
                        name: full,
                        partitioned: true,
                        partitions,
                        persistent,
                        internal: false,
                        message_type: None,
                        namespace: None,
                    })
                })
                .buffered(PARTITION_METADATA_CONCURRENCY)
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .collect::<Result<Vec<_>, _>>()?;
            topics.extend(partitioned_topics);

            let plain: Vec<String> =
                self.get_json(&self.profile.topics_path(&ns.tenant, &ns.namespace, persistent)).await?;
            for full in plain {
                // Skip the per-partition entries of partitioned topics
                // (`...-partition-0`) and the partitioned base names already added.
                if partitioned_set.contains(&full) || is_partition_member(&full, &partitioned_set) {
                    continue;
                }
                topics.push(TopicInfo {
                    short_name: short_topic_name(&full),
                    name: full,
                    partitioned: false,
                    partitions: None,
                    persistent,
                    internal: false,
                    message_type: None,
                    namespace: None,
                });
            }
        }

        Ok(topics)
    }

    async fn create_topic(&self, topic: &TopicRef, partitions: Option<u32>) -> Result<(), String> {
        match partitions {
            Some(count) if count >= 1 => {
                let path = self.profile.topic_partitions_path(topic.domain(), &topic.path());
                let body = serde_json::json!(count);
                self.send_empty(reqwest::Method::PUT, &path, Some(&body), None).await
            }
            _ => {
                let path = self.profile.topic_base_path(topic.domain(), &topic.path());
                self.send_empty(reqwest::Method::PUT, &path, None, None).await
            }
        }
    }

    async fn delete_topic(&self, topic: &TopicRef, force: bool) -> Result<(), String> {
        // Try the partitioned-topic delete first; if the topic is not
        // partitioned the broker returns 404, so fall back to a plain delete.
        let partitions_path = self.profile.topic_partitions_path(topic.domain(), &topic.path());
        let query = force_query(force);
        let resp = self.send(reqwest::Method::DELETE, &partitions_path, None, query.as_deref()).await?;
        if resp.status().is_success() {
            return Ok(());
        }
        if resp.status().as_u16() != 404 {
            return Err(status_error(resp, &partitions_path).await);
        }
        let base_path = self.profile.topic_base_path(topic.domain(), &topic.path());
        self.send_empty(reqwest::Method::DELETE, &base_path, None, query.as_deref()).await
    }

    async fn update_partitions(&self, topic: &TopicRef, partitions: u32) -> Result<(), String> {
        let path = self.profile.topic_partitions_path(topic.domain(), &topic.path());
        let body = serde_json::json!(partitions);
        self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
    }

    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<TopicStats, String> {
        let raw = self.topic_stats_value(topic).await?;
        Ok(self.profile.parse_topic_stats(&raw))
    }

    async fn get_topic_internal_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, String> {
        let path = self.profile.topic_internal_stats_path(topic.domain(), &topic.path());
        self.get_value(&path).await
    }

    // ---- Subscriptions ----

    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<SubscriptionInfo>, String> {
        // The stats payload carries richer per-subscription data than the bare
        // subscriptions list endpoint, so prefer it and parse from there.
        match self.topic_stats_value(topic).await {
            Ok(raw) => {
                let parsed = self.profile.parse_subscriptions(&raw);
                if !parsed.is_empty() {
                    return Ok(parsed);
                }
                // Fall through to the names-only endpoint when stats has no subs
                // (e.g. for partitioned topics, stats may be partition-scoped).
            }
            Err(err) => {
                log::debug!("topic stats unavailable for subscription listing, falling back to names: {err}");
            }
        }

        let names: Vec<String> = self.get_json(&self.profile.subscriptions_path(topic.domain(), &topic.path())).await?;
        Ok(names.into_iter().map(|name| SubscriptionInfo { name, ..Default::default() }).collect())
    }

    async fn create_subscription(&self, topic: &TopicRef, sub: &str, pos: ResetPosition) -> Result<(), String> {
        // PUT .../subscription/{sub} with the desired message id in the body.
        let path = self.profile.subscription_path(topic.domain(), &topic.path(), sub);
        let body = reset_position_message_id(&pos);
        self.send_empty(reqwest::Method::PUT, &path, Some(&body), None).await
    }

    async fn delete_subscription(&self, topic: &TopicRef, sub: &str, force: bool) -> Result<(), String> {
        let path = self.profile.subscription_path(topic.domain(), &topic.path(), sub);
        let query = force_query(force);
        self.send_empty(reqwest::Method::DELETE, &path, None, query.as_deref()).await
    }

    async fn skip_messages(&self, topic: &TopicRef, sub: &str, count: SkipCount) -> Result<(), String> {
        let path = match count {
            SkipCount::All => self.profile.subscription_skip_all_path(topic.domain(), &topic.path(), sub),
            SkipCount::Count { count } => {
                self.profile.subscription_skip_path(topic.domain(), &topic.path(), sub, count)
            }
        };
        self.send_empty(reqwest::Method::POST, &path, None, None).await
    }

    async fn reset_cursor(&self, topic: &TopicRef, sub: &str, pos: ResetPosition) -> Result<(), String> {
        match pos {
            ResetPosition::Timestamp { timestamp_ms } => {
                // POST .../resetcursor/{timestamp}
                let path = format!(
                    "{}/{}",
                    self.profile.subscription_reset_cursor_path(topic.domain(), &topic.path(), sub),
                    timestamp_ms
                );
                self.send_empty(reqwest::Method::POST, &path, None, None).await
            }
            ResetPosition::MessageId { .. } | ResetPosition::Earliest | ResetPosition::Latest => {
                // POST .../resetcursor with a message id body.
                let path = self.profile.subscription_reset_cursor_path(topic.domain(), &topic.path(), sub);
                let body = reset_position_message_id(&pos);
                self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
            }
        }
    }

    async fn clear_backlog(&self, topic: &TopicRef, sub: &str) -> Result<(), String> {
        // Clearing backlog == skipping all messages on the subscription.
        let path = self.profile.subscription_skip_all_path(topic.domain(), &topic.path(), sub);
        self.send_empty(reqwest::Method::POST, &path, None, None).await
    }

    async fn peek_messages(
        &self,
        topic: &TopicRef,
        sub: &str,
        count: u32,
        _options: PeekMessagesOptions,
    ) -> Result<Vec<PeekedMessage>, String> {
        if count == 0 {
            return Ok(Vec::new());
        }

        let messages: Vec<PeekedMessage> = stream::iter(1..=count)
            .map(|position| async move {
                let path = self.profile.subscription_peek_path(topic.domain(), &topic.path(), sub, position);
                let resp = self.send(reqwest::Method::GET, &path, None, None).await?;
                if resp.status().as_u16() == 404 && position > 1 {
                    return Ok::<Option<PeekedMessage>, String>(None);
                }
                let resp = error_for_status(resp, &path).await?;
                let headers = response_headers(resp.headers());
                let payload = resp.bytes().await.map_err(|e| format!("Failed to read peeked message body: {e}"))?;
                Ok(Some(peeked_message_from_response(position, headers, payload.as_ref())))
            })
            .buffered(PEEK_REQUEST_CONCURRENCY)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect();

        Ok(messages)
    }

    async fn expire_messages(&self, topic: &TopicRef, sub: &str, expire_seconds: i64) -> Result<(), String> {
        let path = self.profile.subscription_expire_path(topic.domain(), &topic.path(), sub, expire_seconds);
        self.send_empty(reqwest::Method::POST, &path, None, None).await
    }

    // ---- Producers / consumers ----

    async fn list_producers(&self, topic: &TopicRef) -> Result<Vec<ProducerInfo>, String> {
        let raw = self.topic_stats_value(topic).await?;
        Ok(producers_from_stats_payload(&raw))
    }

    async fn list_consumers(&self, topic: &TopicRef, sub: &str) -> Result<Vec<ConsumerInfo>, String> {
        let subs = self.list_subscriptions(topic).await?;
        Ok(subs.into_iter().find(|s| s.name == sub).map(|s| s.consumers).unwrap_or_default())
    }

    async fn unload_topic(&self, topic: &TopicRef) -> Result<(), String> {
        let path = format!("{}/unload", self.profile.topic_base_path(topic.domain(), &topic.path()));
        self.send_empty(reqwest::Method::PUT, &path, None, None).await
    }

    // ---- Rate limits / quotas / retention ----

    async fn set_publish_rate(&self, scope: &PolicyScope, rate: PublishRate) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => self.profile.namespace_publish_rate_path(tenant, namespace),
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_publish_rate_path(topic_ref.domain(), &topic_ref.path())
            }
        };
        let body = serde_json::to_value(rate).map_err(|e| e.to_string())?;
        self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
    }

    async fn set_dispatch_rate(&self, scope: &PolicyScope, rate: DispatchRate) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => {
                self.profile.namespace_dispatch_rate_path(tenant, namespace)
            }
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_dispatch_rate_path(topic_ref.domain(), &topic_ref.path())
            }
        };
        let body = serde_json::to_value(rate).map_err(|e| e.to_string())?;
        self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
    }

    async fn set_subscribe_rate(&self, scope: &PolicyScope, rate: SubscribeRate) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => {
                self.profile.namespace_subscribe_rate_path(tenant, namespace)
            }
            PolicyScope::Topic { .. } => {
                return Err("subscribe rate is only configurable at the namespace level".to_string());
            }
        };
        let body = serde_json::to_value(rate).map_err(|e| e.to_string())?;
        self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
    }

    async fn set_backlog_quota(&self, scope: &PolicyScope, quota: BacklogQuota) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => {
                self.profile.namespace_backlog_quota_path(tenant, namespace)
            }
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_backlog_quota_path(topic_ref.domain(), &topic_ref.path())
            }
        };
        // `backlogQuotaType` goes in the query string; the limit object in the body.
        let query = vec![("backlogQuotaType".to_string(), quota.quota_type.clone())];
        let body = serde_json::json!({
            "limit": quota.limit_size,
            "limitSize": quota.limit_size,
            "limitTime": quota.limit_time,
            "policy": quota.policy,
        });
        self.send_empty(reqwest::Method::POST, &path, Some(&body), Some(&query)).await
    }

    async fn set_retention(&self, scope: &PolicyScope, retention: RetentionPolicy) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => self.profile.namespace_retention_path(tenant, namespace),
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_retention_path(topic_ref.domain(), &topic_ref.path())
            }
        };
        let body = serde_json::json!({
            "retentionTimeInMinutes": retention.retention_time_in_minutes,
            "retentionSizeInMB": retention.retention_size_in_mb,
        });
        self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
    }

    async fn get_effective_policies(&self, scope: &PolicyScope) -> Result<serde_json::Value, String> {
        match scope {
            PolicyScope::Namespace { tenant, namespace } => {
                self.get_value(&self.profile.namespace_policies_path(tenant, namespace)).await
            }
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                let namespace_policies = self
                    .get_value(&self.profile.namespace_policies_path(&topic_ref.tenant, &topic_ref.namespace))
                    .await?;
                let topic_path = topic_ref.path();
                let publish_rate = self
                    .get_optional_value(&self.profile.topic_publish_rate_path(topic_ref.domain(), &topic_path))
                    .await?;
                let dispatch_rate = self
                    .get_optional_value(&self.profile.topic_dispatch_rate_path(topic_ref.domain(), &topic_path))
                    .await?;
                let backlog_quota = self
                    .get_optional_value(&self.profile.topic_backlog_quota_path(topic_ref.domain(), &topic_path))
                    .await?;
                let retention = self
                    .get_optional_value(&self.profile.topic_retention_path(topic_ref.domain(), &topic_path))
                    .await?;

                Ok(serde_json::json!({
                    "level": "topic",
                    "namespacePolicies": namespace_policies,
                    "topicPolicies": {
                        "publishRate": publish_rate,
                        "dispatchRate": dispatch_rate,
                        "backlogQuota": backlog_quota,
                        "retention": retention,
                    }
                }))
            }
        }
    }

    // ---- Permissions ----

    async fn grant_permission(&self, scope: &PolicyScope, role: &str, actions: Vec<AuthAction>) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => {
                self.profile.namespace_permission_role_path(tenant, namespace, role)
            }
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_permission_role_path(topic_ref.domain(), &topic_ref.path(), role)
            }
        };
        let body = serde_json::to_value(&actions).map_err(|e| e.to_string())?;
        self.send_empty(reqwest::Method::POST, &path, Some(&body), None).await
    }

    async fn revoke_permission(&self, scope: &PolicyScope, role: &str) -> Result<(), String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => {
                self.profile.namespace_permission_role_path(tenant, namespace, role)
            }
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_permission_role_path(topic_ref.domain(), &topic_ref.path(), role)
            }
        };
        self.send_empty(reqwest::Method::DELETE, &path, None, None).await
    }

    async fn list_permissions(&self, scope: &PolicyScope) -> Result<PermissionMap, String> {
        let path = match scope {
            PolicyScope::Namespace { tenant, namespace } => self.profile.namespace_permissions_path(tenant, namespace),
            PolicyScope::Topic { tenant, namespace, topic, persistent } => {
                let topic_ref = TopicRef {
                    tenant: tenant.clone(),
                    namespace: namespace.clone(),
                    topic: topic.clone(),
                    persistent: *persistent,
                    ..Default::default()
                };
                self.profile.topic_permissions_path(topic_ref.domain(), &topic_ref.path())
            }
        };
        let raw: serde_json::Value = self.get_value(&path).await?;
        let mut map = PermissionMap::new();
        if let Some(obj) = raw.as_object() {
            for (role, actions) in obj {
                let parsed: Vec<AuthAction> = actions
                    .as_array()
                    .map(|arr| arr.iter().filter_map(|a| serde_json::from_value(a.clone()).ok()).collect())
                    .unwrap_or_default();
                map.insert(role.clone(), parsed);
            }
        }
        Ok(map)
    }

    // ---- Monitoring ----

    async fn get_backlog(&self, topic: &TopicRef, sub: Option<&str>) -> Result<BacklogStats, String> {
        let stats = self.get_topic_stats(topic).await?;
        Ok(backlog_stats_from_topic_stats(&self.profile, &stats, sub))
    }

    // ---- Escape hatch ----

    async fn raw_request(&self, req: MqRawRequest) -> Result<MqRawResponse, String> {
        let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| format!("Invalid HTTP method: {}", req.method))?;
        // SSRF guard: only a relative path is allowed; it is appended to the
        // connection's admin base. Reject absolute URLs and parent traversal.
        let path = sanitize_raw_path(&req.path)?;
        let query: Option<Vec<(String, String)>> = req.query.map(|m| m.into_iter().collect::<Vec<(String, String)>>());
        let resp = self.send(method, &path, req.body.as_ref(), query.as_deref()).await?;
        let status = resp.status().as_u16();
        // Enforce a response size limit to prevent unbounded memory consumption.
        let content_length = resp.content_length().unwrap_or(0) as usize;
        if content_length > MAX_RAW_RESPONSE_BYTES {
            return Err(format!(
                "Raw response body exceeds the {MAX_RAW_RESPONSE_BYTES}-byte limit ({content_length} bytes reported)"
            ));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Failed to read response body: {e}"))?;
        if bytes.len() > MAX_RAW_RESPONSE_BYTES {
            return Err(format!(
                "Raw response body exceeds the {MAX_RAW_RESPONSE_BYTES}-byte limit ({} bytes received)",
                bytes.len()
            ));
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(body) => Ok(MqRawResponse { status, body, text: None }),
            Err(_) => Ok(MqRawResponse { status, body: serde_json::Value::Null, text: Some(text) }),
        }
    }
}

impl PulsarAdmin {
    async fn topic_stats_value(&self, topic: &TopicRef) -> Result<serde_json::Value, String> {
        if topic.partitioned == Some(true) {
            let partitioned_path = self.profile.topic_partitioned_stats_path(topic.domain(), &topic.path(), true);
            return match self.get_value(&partitioned_path).await {
                Ok(raw) => Ok(raw),
                Err(partitioned_err) => {
                    let stats_path = self.profile.topic_stats_path(topic.domain(), &topic.path());
                    self.get_value(&stats_path).await.map_err(|stats_err| {
                        format!(
                            "partitioned stats {partitioned_path} failed: {partitioned_err}; stats fallback {stats_path} failed: {stats_err}"
                        )
                    })
                }
            };
        }

        let stats_path = self.profile.topic_stats_path(topic.domain(), &topic.path());
        match self.get_value(&stats_path).await {
            Ok(raw) => Ok(raw),
            Err(err) if is_not_found_error(&err) => {
                let partitioned_path = self.profile.topic_partitioned_stats_path(topic.domain(), &topic.path(), true);
                self.get_value(&partitioned_path).await.map_err(|partitioned_err| {
                    format!("{err}; partitioned stats fallback {partitioned_path} failed: {partitioned_err}")
                })
            }
            Err(err) => Err(err),
        }
    }

    async fn partition_count_for_topic(&self, domain: &str, full_topic_name: &str) -> Result<Option<u32>, String> {
        let path = self.profile.topic_partitions_path(domain, topic_path_from_full_name(full_topic_name));
        match self.get_value(&path).await {
            Ok(raw) => Ok(partition_count_from_metadata(&raw)),
            Err(err) if is_unsupported_endpoint_error(&err) => {
                log::debug!("partition metadata unavailable for {full_topic_name}: {err}");
                Ok(None)
            }
            Err(err) => Err(err),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn build_http_client(
    tls_skip_verify: bool,
    connect_override: Option<&MqConnectOverride>,
    admin_url: &str,
) -> Result<reqwest::Client, String> {
    let mut builder = crate::db::http_client_builder(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS));
    if tls_skip_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let Some(connect_override) = connect_override {
        let url = reqwest::Url::parse(admin_url).map_err(|e| format!("MQ Admin URL is invalid: {e}"))?;
        let original_host = url.host_str().ok_or("MQ Admin URL host is empty")?;
        let override_ip = connect_override
            .host
            .parse::<IpAddr>()
            .map_err(|e| format!("MQ transport endpoint host must be an IP address: {e}"))?;
        builder = builder.resolve(original_host, SocketAddr::new(override_ip, connect_override.port));
    }
    builder.build().map_err(|e| format!("Failed to build HTTP client: {e}"))
}

fn normalize_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Redact any userinfo in the base URL for logging.
fn redact_base(base: &str) -> String {
    match base.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('@') {
            Some((_, host)) => format!("{scheme}://***@{host}"),
            None => base.to_string(),
        },
        None => base.to_string(),
    }
}

/// Detect the broker version: honour a pinned version first, otherwise probe
/// `brokers/version`, otherwise fall back to the baseline profile.
async fn detect_version(
    http: &reqwest::Client,
    base: &str,
    auth: &MqAuth,
    cache: &TokenCache,
    pinned: Option<&str>,
) -> DetectedVersion {
    if let Some(pinned) = pinned.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(version) = PulsarApiProfile::parse_version(pinned) {
            return DetectedVersion { version, detection: VersionDetection::Pinned, raw: Some(pinned.to_string()) };
        }
        log::warn!("Pinned Pulsar version '{pinned}' is not recognised; probing instead");
    }

    let url = format!("{base}/admin/v2/brokers/version");
    let req = http.get(&url).timeout(std::time::Duration::from_secs(PROBE_TIMEOUT_SECS));
    let probed = match auth.apply(req, http, cache).await {
        Ok(req) => req.send().await,
        Err(err) => {
            log::warn!("Pulsar version probe auth failed: {err}; using baseline profile");
            return fallback_detection();
        }
    };

    match probed {
        Ok(resp) if resp.status().is_success() => {
            let raw = resp.text().await.unwrap_or_default();
            match PulsarApiProfile::parse_version(&raw) {
                Some(version) => {
                    DetectedVersion { version, detection: VersionDetection::Probed, raw: Some(raw.trim().to_string()) }
                }
                None => {
                    log::info!("Pulsar broker reported version '{}', not first-party; using baseline", raw.trim());
                    DetectedVersion {
                        version: PulsarVersion::V3_1,
                        detection: VersionDetection::Fallback,
                        raw: Some(raw.trim().to_string()),
                    }
                }
            }
        }
        Ok(resp) => {
            log::warn!("Pulsar version probe returned {}; using baseline profile", resp.status());
            fallback_detection()
        }
        Err(err) => {
            log::warn!("Pulsar version probe failed: {err}; using baseline profile");
            fallback_detection()
        }
    }
}

fn fallback_detection() -> DetectedVersion {
    DetectedVersion { version: PulsarVersion::V3_1, detection: VersionDetection::Fallback, raw: None }
}

/// Return a `["force","true"]`-style query parameter list when `force` is set.
fn force_query(force: bool) -> Option<Vec<(String, String)>> {
    force.then(|| vec![("force".to_string(), "true".to_string())])
}

async fn error_for_status(resp: reqwest::Response, path: &str) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        Err(status_error(resp, path).await)
    }
}

async fn status_error(resp: reqwest::Response, path: &str) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = if body.trim().is_empty() { String::new() } else { format!(": {}", truncate(&body, 400)) };
    format!("Pulsar admin {path} returned {status}{detail}")
}

fn string_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// The short topic name from a full name like
/// `persistent://public/default/orders` -> `orders`.
fn short_topic_name(full: &str) -> String {
    let path = topic_path_from_full_name(full);
    let mut parts = path.splitn(3, '/');
    let fallback = path.rsplit('/').next().unwrap_or(path);
    match (parts.next(), parts.next(), parts.next()) {
        (Some(_tenant), Some(_namespace), Some(topic)) => topic.to_string(),
        _ => fallback.to_string(),
    }
}

fn topic_path_from_full_name(full: &str) -> &str {
    full.split_once("://").map(|(_, path)| path).unwrap_or(full)
}

fn partition_count_from_metadata(raw: &serde_json::Value) -> Option<u32> {
    let count = raw.get("partitions").and_then(serde_json::Value::as_u64).or_else(|| raw.as_u64())?;
    u32::try_from(count).ok().filter(|count| *count > 0)
}

fn is_not_found_error(err: &str) -> bool {
    err.contains(" returned 404 ") || err.contains("404 Not Found")
}

fn is_method_not_allowed_error(err: &str) -> bool {
    err.contains(" returned 405 ") || err.contains("405 Method Not Allowed")
}

fn is_unsupported_endpoint_error(err: &str) -> bool {
    is_not_found_error(err) || is_method_not_allowed_error(err)
}

fn producers_from_stats_payload(raw: &serde_json::Value) -> Vec<ProducerInfo> {
    let mut producers = Vec::new();
    append_producers_from_stats(raw, &mut producers);
    if let Some(partitions) = raw.get("partitions").and_then(serde_json::Value::as_object) {
        for partition_stats in partitions.values() {
            append_producers_from_stats(partition_stats, &mut producers);
        }
    }
    producers
}

fn append_producers_from_stats(raw: &serde_json::Value, producers: &mut Vec<ProducerInfo>) {
    if let Some(items) = raw.get("publishers").and_then(serde_json::Value::as_array) {
        producers.extend(items.iter().map(parse_producer));
    }
}

/// Whether `full` is a per-partition member (`...-partition-N`) of one of the
/// partitioned base topics.
fn is_partition_member(full: &str, partitioned: &std::collections::HashSet<String>) -> bool {
    if let Some(idx) = full.rfind("-partition-") {
        let (base, suffix) = full.split_at(idx);
        let n = &suffix["-partition-".len()..];
        if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
            return partitioned.contains(base);
        }
    }
    false
}

/// Build a message-id body for reset-cursor / create-subscription based on the
/// requested position. Earliest/latest use the sentinel ledger/entry ids Pulsar
/// recognises.
fn reset_position_message_id(pos: &ResetPosition) -> serde_json::Value {
    match pos {
        ResetPosition::Earliest => serde_json::json!({ "ledgerId": -1, "entryId": -1 }),
        ResetPosition::Latest => serde_json::json!({ "ledgerId": i64::MAX, "entryId": i64::MAX }),
        ResetPosition::MessageId { ledger_id, entry_id } => {
            serde_json::json!({ "ledgerId": ledger_id, "entryId": entry_id })
        }
        // Timestamp is handled by a dedicated path; default to latest here.
        ResetPosition::Timestamp { .. } => serde_json::json!({ "ledgerId": i64::MAX, "entryId": i64::MAX }),
    }
}

fn parse_producer(v: &serde_json::Value) -> ProducerInfo {
    ProducerInfo {
        producer_id: v.get("producerId").and_then(serde_json::Value::as_i64).unwrap_or(0),
        producer_name: v.get("producerName").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        msg_rate_in: v.get("msgRateIn").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        msg_throughput_in: v.get("msgThroughputIn").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        address: v.get("address").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        client_version: v.get("clientVersion").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
    }
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect()
}

fn peeked_message_from_response(position: u32, headers: HashMap<String, String>, payload: &[u8]) -> PeekedMessage {
    let properties = headers
        .iter()
        .filter_map(|(name, value)| {
            name.strip_prefix("x-pulsar-property-").map(|property| (property.to_string(), value.clone()))
        })
        .collect();
    PeekedMessage {
        position,
        message_id: header_value(&headers, &["x-pulsar-message-id", "x-pulsar-messageid"]),
        key: header_value(&headers, &["x-pulsar-key", "x-pulsar-message-key"]),
        publish_time: header_value(&headers, &["x-pulsar-publish-time", "x-pulsar-publish-time-ms"]),
        event_time: header_value(&headers, &["x-pulsar-event-time", "x-pulsar-event-time-ms"]),
        properties,
        headers,
        payload_base64: BASE64.encode(payload),
        payload_text: std::str::from_utf8(payload).ok().map(str::to_string),
    }
}

fn header_value(headers: &HashMap<String, String>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| headers.get(*name).cloned())
}

/// Validate a raw request path: must be a relative path beginning with `/`, no
/// scheme/host, no `..` traversal.
fn sanitize_raw_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Raw request path is empty".to_string());
    }
    if trimmed.contains("://") || trimmed.starts_with("//") {
        return Err("Raw request path must be relative to the admin base (no scheme/host allowed)".to_string());
    }
    if !trimmed.starts_with('/') {
        return Err("Raw request path must start with '/'".to_string());
    }
    if trimmed.split('/').any(|seg| seg == "..") {
        return Err("Raw request path must not contain '..'".to_string());
    }
    Ok(trimmed.to_string())
}

fn backlog_stats_from_topic_stats(profile: &PulsarApiProfile, stats: &TopicStats, sub: Option<&str>) -> BacklogStats {
    let subs = profile.parse_subscriptions(&stats.raw);
    let msg_backlog = match sub {
        Some(name) => subs.into_iter().find(|s| s.name == name).map(|s| s.msg_backlog).unwrap_or(0),
        None => subs.into_iter().fold(0_i64, |total, sub| total.saturating_add(sub.msg_backlog)),
    };

    BacklogStats { msg_backlog, backlog_size: stats.backlog_size }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex;

    #[derive(Clone)]
    struct MockRoute {
        method: &'static str,
        path: &'static str,
        status: u16,
        body: &'static str,
    }

    #[derive(Clone, Debug)]
    struct ObservedRequest {
        method: String,
        path: String,
        body: String,
    }

    struct MockPulsarServer {
        base_url: String,
        observed: std::sync::Arc<Mutex<Vec<ObservedRequest>>>,
    }

    impl MockPulsarServer {
        async fn spawn(routes: Vec<MockRoute>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("failed to bind test server socket");
            let addr = listener.local_addr().expect("failed to get test server local address");
            let routes = std::sync::Arc::new(routes);
            let observed = std::sync::Arc::new(Mutex::new(Vec::new()));
            let server_observed = observed.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        break;
                    };
                    let routes = routes.clone();
                    let observed = server_observed.clone();
                    tokio::spawn(async move {
                        let Some(request) = read_mock_request(&mut stream).await else {
                            return;
                        };
                        let response = routes
                            .iter()
                            .find(|route| route.method == request.method && route.path == request.path)
                            .cloned()
                            .unwrap_or(MockRoute {
                                method: "GET",
                                path: "",
                                status: 500,
                                body: r#"{"reason":"unexpected request"}"#,
                            });
                        observed.lock().await.push(request);
                        write_mock_response(&mut stream, response.status, response.body).await;
                    });
                }
            });

            Self { base_url: format!("http://{addr}"), observed }
        }

        async fn admin(&self) -> PulsarAdmin {
            PulsarAdmin::new(MqAdminConfig {
                system_kind: MqSystemKind::Pulsar,
                admin_url: self.base_url.clone(),
                auth: MqAuth::None,
                tls_skip_verify: false,
                pinned_version: Some("3.1".to_string()),
                token_signing: None,
                connect_override: None,
                extra: serde_json::Value::Null,
            })
            .await
            .expect("failed to create test Pulsar admin client")
        }

        async fn observed(&self) -> Vec<ObservedRequest> {
            self.observed.lock().await.clone()
        }
    }

    async fn read_mock_request(stream: &mut TcpStream) -> Option<ObservedRequest> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        let header_end = loop {
            let n = stream.read(&mut tmp).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(index) = find_header_end(&buf) {
                break index;
            }
        };

        let header = String::from_utf8_lossy(&buf[..header_end]);
        let mut lines = header.lines();
        let first = lines.next()?;
        let mut parts = first.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        let content_length = lines
            .filter_map(|line| line.split_once(':'))
            .find_map(|(name, value)| {
                name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
            })
            .unwrap_or(0);

        let body_start = header_end + 4;
        let mut body = buf.get(body_start..).unwrap_or_default().to_vec();
        while body.len() < content_length {
            let n = stream.read(&mut tmp).await.ok()?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(content_length);

        Some(ObservedRequest { method, path, body: String::from_utf8_lossy(&body).to_string() })
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|window| window == b"\r\n\r\n")
    }

    async fn write_mock_response(stream: &mut TcpStream, status: u16, body: &str) {
        let reason = match status {
            200 => "OK",
            204 => "No Content",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            500 => "Internal Server Error",
            _ => "OK",
        };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
    }

    fn assert_json_body(request: &ObservedRequest, expected: serde_json::Value) {
        let actual: serde_json::Value =
            serde_json::from_str(&request.body).expect("test request body should be valid JSON");
        assert_eq!(actual, expected);
    }

    #[test]
    fn normalizes_base_url() {
        assert_eq!(normalize_base("http://x:8080/"), "http://x:8080");
        assert_eq!(normalize_base("  http://x:8080  "), "http://x:8080");
    }

    #[test]
    fn redacts_userinfo() {
        assert_eq!(redact_base("http://user:pw@host:8080"), "http://***@host:8080");
        assert_eq!(redact_base("http://host:8080"), "http://host:8080");
    }

    #[test]
    fn short_topic_name_extracts_last_segment() {
        assert_eq!(short_topic_name("persistent://public/default/orders"), "orders");
        assert_eq!(short_topic_name("persistent://public/default/orders/a"), "orders/a");
        assert_eq!(short_topic_name("non-persistent://tenant/ns/topic/with/slash"), "topic/with/slash");
    }

    #[test]
    fn partition_count_from_metadata_reads_pulsar_shapes() {
        assert_eq!(partition_count_from_metadata(&serde_json::json!({ "partitions": 4 })), Some(4));
        assert_eq!(partition_count_from_metadata(&serde_json::json!(8)), Some(8));
        assert_eq!(partition_count_from_metadata(&serde_json::json!({ "partitions": 0 })), None);
    }

    #[tokio::test]
    async fn list_tenants_returns_detail_server_errors() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute { method: "GET", path: "/admin/v2/tenants", status: 200, body: r#"["acme"]"# },
            MockRoute { method: "GET", path: "/admin/v2/tenants/acme", status: 500, body: r#"{"reason":"boom"}"# },
        ])
        .await;
        let admin = server.admin().await;

        let err = admin.list_tenants().await.unwrap_err();

        assert!(err.contains("/admin/v2/tenants/acme"));
        assert!(err.contains("500 Internal Server Error"));
    }

    #[tokio::test]
    async fn list_namespaces_returns_permission_server_errors() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute { method: "GET", path: "/admin/v2/namespaces/acme", status: 200, body: r#"["acme/events"]"# },
            MockRoute {
                method: "GET",
                path: "/admin/v2/namespaces/acme/events/permissions",
                status: 403,
                body: r#"{"reason":"denied"}"#,
            },
        ])
        .await;
        let admin = server.admin().await;

        let err = admin.list_namespaces("acme").await.unwrap_err();

        assert!(err.contains("/admin/v2/namespaces/acme/events/permissions"));
        assert!(err.contains("403 Forbidden"));
    }

    #[tokio::test]
    async fn list_topics_returns_partitioned_topic_list_server_errors() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute {
                method: "GET",
                path: "/admin/v2/persistent/public/default/partitioned",
                status: 500,
                body: r#"{"reason":"boom"}"#,
            },
            MockRoute { method: "GET", path: "/admin/v2/persistent/public/default", status: 200, body: "[]" },
        ])
        .await;
        let admin = server.admin().await;

        let err = admin
            .list_topics(
                &NamespaceRef { tenant: "public".to_string(), namespace: "default".to_string() },
                ListTopicsOpts { include_non_persistent: false },
            )
            .await
            .unwrap_err();

        assert!(err.contains("/admin/v2/persistent/public/default/partitioned"));
        assert!(err.contains("500 Internal Server Error"));
    }

    #[tokio::test]
    async fn list_topics_allows_unsupported_partitioned_topic_endpoint() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute {
                method: "GET",
                path: "/admin/v2/persistent/public/default/partitioned",
                status: 404,
                body: r#"{"reason":"not enabled"}"#,
            },
            MockRoute {
                method: "GET",
                path: "/admin/v2/persistent/public/default",
                status: 200,
                body: r#"["persistent://public/default/plain"]"#,
            },
        ])
        .await;
        let admin = server.admin().await;

        let topics = admin
            .list_topics(
                &NamespaceRef { tenant: "public".to_string(), namespace: "default".to_string() },
                ListTopicsOpts { include_non_persistent: false },
            )
            .await
            .expect("list_topics should succeed");

        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].name, "persistent://public/default/plain");
        assert!(!topics[0].partitioned);
    }

    #[tokio::test]
    async fn list_topics_returns_partition_metadata_errors() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute {
                method: "GET",
                path: "/admin/v2/persistent/public/default/partitioned",
                status: 200,
                body: r#"["persistent://public/default/orders"]"#,
            },
            MockRoute {
                method: "GET",
                path: "/admin/v2/persistent/public/default/orders/partitions",
                status: 403,
                body: r#"{"reason":"denied"}"#,
            },
            MockRoute { method: "GET", path: "/admin/v2/persistent/public/default", status: 200, body: "[]" },
        ])
        .await;
        let admin = server.admin().await;

        let err = admin
            .list_topics(
                &NamespaceRef { tenant: "public".to_string(), namespace: "default".to_string() },
                ListTopicsOpts { include_non_persistent: false },
            )
            .await
            .unwrap_err();

        assert!(err.contains("/admin/v2/persistent/public/default/orders/partitions"));
        assert!(err.contains("403 Forbidden"));
    }

    #[tokio::test]
    async fn mutating_methods_use_expected_http_contracts() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute { method: "PUT", path: "/admin/v2/tenants/acme", status: 204, body: "" },
            MockRoute { method: "PUT", path: "/admin/v2/namespaces/acme/events", status: 204, body: "" },
            MockRoute {
                method: "PUT",
                path: "/admin/v2/persistent/acme/events/orders/partitions",
                status: 204,
                body: "",
            },
            MockRoute {
                method: "PUT",
                path: "/admin/v2/persistent/acme/events/orders/subscription/sub%2Frole%20%231",
                status: 204,
                body: "",
            },
            MockRoute { method: "POST", path: "/admin/v2/namespaces/acme/events/publishRate", status: 204, body: "" },
            MockRoute { method: "GET", path: "/admin/v2/clusters", status: 200, body: r#"["ec-pulsar"]"# },
        ])
        .await;
        let admin = server.admin().await;

        admin
            .create_tenant(
                "acme",
                TenantConfig {
                    admin_roles: vec!["admin".to_string()],
                    allowed_clusters: vec!["ec-pulsar".to_string()],
                },
            )
            .await
            .expect("create_tenant should succeed");
        admin
            .create_namespace(
                &NamespaceRef { tenant: "acme".to_string(), namespace: "events".to_string() },
                NamespaceConfig { clusters: vec!["ec-pulsar".to_string()], bundles: Some(16) },
            )
            .await
            .expect("create_namespace should succeed");
        let topic = TopicRef {
            tenant: "acme".to_string(),
            namespace: "events".to_string(),
            topic: "orders".to_string(),
            persistent: true,
            partitioned: Some(true),
            ..Default::default()
        };
        admin.create_topic(&topic, Some(3)).await.expect("create_topic should succeed");
        admin
            .create_subscription(&topic, "sub/role #1", ResetPosition::Latest)
            .await
            .expect("create_subscription should succeed");
        admin
            .set_publish_rate(
                &PolicyScope::Namespace { tenant: "acme".to_string(), namespace: "events".to_string() },
                PublishRate { publish_throttling_rate_in_msg: 10, publish_throttling_rate_in_byte: 2048 },
            )
            .await
            .expect("set_publish_rate should succeed");
        let raw = admin
            .raw_request(MqRawRequest {
                method: "GET".to_string(),
                path: "/admin/v2/clusters".to_string(),
                query: None,
                body: None,
            })
            .await
            .expect("raw_admin_request should succeed");
        assert_eq!(raw.status, 200);
        assert_eq!(raw.body, serde_json::json!(["ec-pulsar"]));

        let observed = server.observed().await;
        let method_paths = observed.iter().map(|req| (req.method.as_str(), req.path.as_str())).collect::<Vec<_>>();
        assert_eq!(
            method_paths,
            vec![
                ("PUT", "/admin/v2/tenants/acme"),
                ("PUT", "/admin/v2/namespaces/acme/events"),
                ("PUT", "/admin/v2/persistent/acme/events/orders/partitions"),
                ("PUT", "/admin/v2/persistent/acme/events/orders/subscription/sub%2Frole%20%231"),
                ("POST", "/admin/v2/namespaces/acme/events/publishRate"),
                ("GET", "/admin/v2/clusters"),
            ]
        );
        assert_json_body(
            &observed[0],
            serde_json::json!({ "adminRoles": ["admin"], "allowedClusters": ["ec-pulsar"] }),
        );
        assert_json_body(
            &observed[1],
            serde_json::json!({ "replication_clusters": ["ec-pulsar"], "bundles": { "numBundles": 16 } }),
        );
        assert_json_body(&observed[2], serde_json::json!(3));
        assert_json_body(&observed[3], serde_json::json!({ "ledgerId": i64::MAX, "entryId": i64::MAX }));
        assert_json_body(
            &observed[4],
            serde_json::json!({ "publishThrottlingRateInMsg": 10, "publishThrottlingRateInByte": 2048 }),
        );
        assert!(observed[5].body.is_empty());
    }

    #[tokio::test]
    async fn status_errors_include_path_status_and_body() {
        let server = MockPulsarServer::spawn(vec![
            MockRoute { method: "GET", path: "/admin/v2/tenants", status: 401, body: r#"{"reason":"missing token"}"# },
            MockRoute {
                method: "GET",
                path: "/admin/v2/tenants/forbidden",
                status: 403,
                body: r#"{"reason":"denied"}"#,
            },
            MockRoute {
                method: "GET",
                path: "/admin/v2/namespaces/public/missing",
                status: 404,
                body: r#"{"reason":"missing"}"#,
            },
            MockRoute { method: "GET", path: "/admin/v2/clusters", status: 500, body: r#"{"reason":"broker down"}"# },
        ])
        .await;
        let admin = server.admin().await;

        let unauthorized = admin.list_tenants().await.unwrap_err();
        assert!(unauthorized.contains("/admin/v2/tenants"));
        assert!(unauthorized.contains("401 Unauthorized"));
        assert!(unauthorized.contains("missing token"));

        let forbidden = admin.get_tenant("forbidden").await.unwrap_err();
        assert!(forbidden.contains("/admin/v2/tenants/forbidden"));
        assert!(forbidden.contains("403 Forbidden"));
        assert!(forbidden.contains("denied"));

        let missing = admin
            .get_namespace_policies(&NamespaceRef { tenant: "public".to_string(), namespace: "missing".to_string() })
            .await
            .unwrap_err();
        assert!(missing.contains("/admin/v2/namespaces/public/missing"));
        assert!(missing.contains("404 Not Found"));
        assert!(missing.contains("missing"));

        let server_error = admin.test_connection().await.unwrap_err();
        assert!(server_error.contains("/admin/v2/clusters"));
        assert!(server_error.contains("500 Internal Server Error"));
        assert!(server_error.contains("broker down"));
    }

    #[test]
    fn producers_from_stats_payload_reads_partitioned_stats() {
        let raw = serde_json::json!({
            "publishers": [{ "producerId": 10, "producerName": "aggregate" }],
            "partitions": {
                "persistent://b2b/ec-product-service/goods_status_change-partition-0": {
                    "publishers": [{ "producerId": 1, "producerName": "p0" }]
                },
                "persistent://b2b/ec-product-service/goods_status_change-partition-1": {
                    "publishers": [{ "producerId": 2, "producerName": "p1" }]
                }
            }
        });

        let producers = producers_from_stats_payload(&raw);

        assert_eq!(
            producers.iter().map(|producer| producer.producer_name.as_str()).collect::<Vec<_>>(),
            vec!["aggregate", "p0", "p1"]
        );
    }

    #[test]
    fn detects_partition_members() {
        let mut set = std::collections::HashSet::new();
        set.insert("persistent://public/default/orders".to_string());
        assert!(is_partition_member("persistent://public/default/orders-partition-0", &set));
        assert!(!is_partition_member("persistent://public/default/orders-partition-x", &set));
        assert!(!is_partition_member("persistent://public/default/other", &set));
    }

    #[test]
    fn sanitizes_raw_paths() {
        assert!(sanitize_raw_path("/admin/v2/tenants").is_ok());
        assert!(sanitize_raw_path("http://evil/x").is_err());
        assert!(sanitize_raw_path("//evil/x").is_err());
        assert!(sanitize_raw_path("admin/v2").is_err());
        assert!(sanitize_raw_path("/admin/../../etc").is_err());
        assert!(sanitize_raw_path("   ").is_err());
    }

    #[test]
    fn topic_backlog_sums_subscription_backlogs() {
        let profile = PulsarApiProfile::default_baseline();
        let stats = TopicStats {
            msg_rate_in: 0.0,
            msg_rate_out: 0.0,
            msg_throughput_in: 0.0,
            msg_throughput_out: 0.0,
            storage_size: 0,
            backlog_size: 4096,
            msg_in_counter: 0,
            msg_out_counter: 0,
            subscription_count: 2,
            producer_count: 0,
            raw: serde_json::json!({
                "subscriptions": {
                    "sub-a": { "msgBacklog": 7 },
                    "sub-b": { "msgBacklog": 11 }
                }
            }),
        };

        let backlog = backlog_stats_from_topic_stats(&profile, &stats, None);

        assert_eq!(backlog.msg_backlog, 18);
        assert_eq!(backlog.backlog_size, 4096);
    }

    #[test]
    fn reset_position_message_ids() {
        assert_eq!(
            reset_position_message_id(&ResetPosition::Earliest),
            serde_json::json!({"ledgerId": -1, "entryId": -1})
        );
        let mid = reset_position_message_id(&ResetPosition::MessageId { ledger_id: 5, entry_id: 9 });
        assert_eq!(mid, serde_json::json!({"ledgerId": 5, "entryId": 9}));
    }

    #[test]
    fn force_query_only_when_true() {
        assert!(force_query(false).is_none());
        assert_eq!(
            force_query(true).expect("force=true should produce query params"),
            vec![("force".to_string(), "true".to_string())]
        );
    }

    #[test]
    fn builds_peeked_message_from_headers_and_payload() {
        let message = peeked_message_from_response(
            2,
            HashMap::from([
                ("x-pulsar-message-id".to_string(), "1:2:3".to_string()),
                ("x-pulsar-key".to_string(), "order-1".to_string()),
                ("x-pulsar-property-source".to_string(), "api".to_string()),
            ]),
            b"hello",
        );

        assert_eq!(message.position, 2);
        assert_eq!(message.message_id.as_deref(), Some("1:2:3"));
        assert_eq!(message.key.as_deref(), Some("order-1"));
        assert_eq!(message.properties.get("source").map(String::as_str), Some("api"));
        assert_eq!(message.payload_base64, "aGVsbG8=");
        assert_eq!(message.payload_text.as_deref(), Some("hello"));
    }
}
