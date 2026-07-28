//! Pulsar version detection and the version "profile" that isolates all
//! version-specific behaviour (endpoint paths + response parsing + capability
//! flags) behind one object. Adapter methods express *what* to do; the profile
//! decides *how*, per the resolved version.
//!
//! First-party scope is **Pulsar 3.1.x** (REST-contract compatible with the
//! 3.0.x LTS line). Newer versions are handled additively: add a `PulsarVersion`
//! variant, add the differing path/parse branches here, and the adapter, service
//! layer, commands, routes, and frontend stay untouched. See
//! `docs/message-queue-admin-design.zh-CN.md` chapter 10.

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

use super::super::types::{MqCapabilities, SubscriptionInfo, TopicStats};

/// A recognised Pulsar major/minor line. Unknown versions fall back to the
/// nearest known profile in conservative mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PulsarVersion {
    /// Pulsar 3.0.x / 3.1.x — the first-party baseline.
    V3_1,
}

impl PulsarVersion {
    pub fn label(self) -> &'static str {
        match self {
            PulsarVersion::V3_1 => "3.1.x",
        }
    }
}

/// How the version was determined. Surfaced to the UI so users understand
/// whether the adapter is running on a confirmed version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionDetection {
    /// Probed from `brokers/version`.
    Probed,
    /// Pinned by the user in connection config.
    Pinned,
    /// Could not determine; using the default baseline profile.
    Fallback,
}

impl VersionDetection {
    pub fn as_str(self) -> &'static str {
        match self {
            VersionDetection::Probed => "probed",
            VersionDetection::Pinned => "pinned",
            VersionDetection::Fallback => "fallback",
        }
    }
}

/// Resolved version picture: which version, how we found it, and the raw string.
#[derive(Debug, Clone)]
pub struct DetectedVersion {
    pub version: PulsarVersion,
    pub detection: VersionDetection,
    pub raw: Option<String>,
}

/// The version profile: a single object that answers every version-dependent
/// question. Adapter methods route all path construction and response parsing
/// through here.
#[derive(Debug, Clone)]
pub struct PulsarApiProfile {
    version: PulsarVersion,
    detection: VersionDetection,
    raw_version: Option<String>,
}

impl PulsarApiProfile {
    /// Resolve a profile from a detected version.
    pub fn resolve(detected: DetectedVersion) -> Self {
        Self { version: detected.version, detection: detected.detection, raw_version: detected.raw }
    }

    /// The default baseline profile (3.1.x), used when detection fails.
    pub fn default_baseline() -> Self {
        Self { version: PulsarVersion::V3_1, detection: VersionDetection::Fallback, raw_version: None }
    }

    pub fn version(&self) -> PulsarVersion {
        self.version
    }

    pub fn detection(&self) -> VersionDetection {
        self.detection
    }

    pub fn raw_version(&self) -> Option<&str> {
        self.raw_version.as_deref()
    }

    pub fn label(&self) -> &'static str {
        self.version.label()
    }

    /// Parse a raw broker version string (e.g. `3.1.2`, `3.0.7`, or
    /// `Pulsar version 3.1.2 ...`) into a known [`PulsarVersion`].
    pub fn parse_version(raw: &str) -> Option<PulsarVersion> {
        let trimmed = raw.trim();
        // Find the first dotted numeric token.
        let token = trimmed.split_whitespace().find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()));
        let token = token.unwrap_or(trimmed);
        let mut nums = token.split('.');
        let major: u32 = nums.next()?.trim().parse().ok()?;
        let _minor: u32 = nums.next().and_then(|m| m.trim().parse().ok()).unwrap_or(0);
        // 3.x (and the 3.0/3.1 LTS family) map onto the V3_1 baseline.
        match major {
            3 => Some(PulsarVersion::V3_1),
            // Newer majors are not yet first-party; caller decides fallback.
            _ => None,
        }
    }

    /// Capability flags for this version. Older versions missing endpoints would
    /// turn the corresponding flag off here so the UI hides them.
    pub fn capabilities(&self) -> MqCapabilities {
        match self.version {
            PulsarVersion::V3_1 => MqCapabilities {
                supports_tenants: true,
                supports_namespaces: true,
                supports_partitioned_topics: true,
                supports_subscriptions: true,
                supports_create_subscription: true,
                supports_reset_cursor: true,
                supports_skip_messages: true,
                supports_clear_backlog: true,
                supports_peek_messages: true,
                supports_expire_messages: true,
                supports_rate_limits: true,
                supports_backlog_quota: true,
                supports_retention: true,
                supports_permissions: true,
                supports_geo_replication: true,
                // Token signing is NOT a broker REST capability — see chapter 11.
                supports_token_management: false,
                supports_raw_admin_api: true,
                supports_send_message: false,
                supports_message_query: false,
                supports_dlq: false,
                supports_message_trace: false,
                supports_exchanges: false,
                supports_client_connections: false,
                supports_user_permissions: false,
                supports_policies: false,
                supports_cluster_monitoring: false,
            },
        }
    }

    // ---- Path construction (all relative to the admin base) ----

    pub fn broker_version_path(&self) -> String {
        "/admin/v2/brokers/version".to_string()
    }

    pub fn clusters_path(&self) -> String {
        "/admin/v2/clusters".to_string()
    }

    pub fn tenants_path(&self) -> String {
        "/admin/v2/tenants".to_string()
    }

    pub fn tenant_path(&self, tenant: &str) -> String {
        format!("/admin/v2/tenants/{}", encode_segment(tenant))
    }

    pub fn namespaces_path(&self, tenant: &str) -> String {
        format!("/admin/v2/namespaces/{}", encode_segment(tenant))
    }

    pub fn namespace_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn namespace_policies_path(&self, tenant: &str, namespace: &str) -> String {
        // GET on the namespace itself returns its policies.
        self.namespace_path(tenant, namespace)
    }

    pub fn topics_path(&self, tenant: &str, namespace: &str, persistent: bool) -> String {
        let domain = if persistent { "persistent" } else { "non-persistent" };
        format!("/admin/v2/{domain}/{}/{}", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn partitioned_topics_path(&self, tenant: &str, namespace: &str, persistent: bool) -> String {
        let domain = if persistent { "persistent" } else { "non-persistent" };
        format!("/admin/v2/{domain}/{}/{}/partitioned", encode_segment(tenant), encode_segment(namespace))
    }

    /// Base path for a single topic: `/admin/v2/{domain}/{tenant}/{ns}/{topic}`.
    pub fn topic_base_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}", encode_topic_path(topic_path))
    }

    pub fn topic_partitions_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/partitions", encode_topic_path(topic_path))
    }

    pub fn topic_stats_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/stats", encode_topic_path(topic_path))
    }

    pub fn topic_partitioned_stats_path(&self, domain: &str, topic_path: &str, per_partition: bool) -> String {
        let path = format!("/admin/v2/{domain}/{}/partitioned-stats", encode_topic_path(topic_path));
        if per_partition {
            format!("{path}?perPartition=true")
        } else {
            path
        }
    }

    pub fn topic_internal_stats_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/internalStats", encode_topic_path(topic_path))
    }

    pub fn subscriptions_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/subscriptions", encode_topic_path(topic_path))
    }

    pub fn subscription_path(&self, domain: &str, topic_path: &str, sub: &str) -> String {
        format!("/admin/v2/{domain}/{}/subscription/{}", encode_topic_path(topic_path), encode_segment(sub))
    }

    pub fn subscription_reset_cursor_path(&self, domain: &str, topic_path: &str, sub: &str) -> String {
        format!("/admin/v2/{domain}/{}/subscription/{}/resetcursor", encode_topic_path(topic_path), encode_segment(sub))
    }

    pub fn subscription_skip_path(&self, domain: &str, topic_path: &str, sub: &str, count: u32) -> String {
        format!(
            "/admin/v2/{domain}/{}/subscription/{}/skip/{count}",
            encode_topic_path(topic_path),
            encode_segment(sub)
        )
    }

    pub fn subscription_skip_all_path(&self, domain: &str, topic_path: &str, sub: &str) -> String {
        format!("/admin/v2/{domain}/{}/subscription/{}/skip_all", encode_topic_path(topic_path), encode_segment(sub))
    }

    pub fn subscription_peek_path(&self, domain: &str, topic_path: &str, sub: &str, position: u32) -> String {
        format!(
            "/admin/v2/{domain}/{}/subscription/{}/position/{position}",
            encode_topic_path(topic_path),
            encode_segment(sub)
        )
    }

    pub fn subscription_expire_path(&self, domain: &str, topic_path: &str, sub: &str, expire_seconds: i64) -> String {
        format!(
            "/admin/v2/{domain}/{}/subscription/{}/expireMessages/{expire_seconds}",
            encode_topic_path(topic_path),
            encode_segment(sub)
        )
    }

    pub fn topic_permissions_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/permissions", encode_topic_path(topic_path))
    }

    pub fn topic_permission_role_path(&self, domain: &str, topic_path: &str, role: &str) -> String {
        format!("/admin/v2/{domain}/{}/permissions/{}", encode_topic_path(topic_path), encode_segment(role))
    }

    pub fn namespace_permissions_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}/permissions", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn namespace_permission_role_path(&self, tenant: &str, namespace: &str, role: &str) -> String {
        format!(
            "/admin/v2/namespaces/{}/{}/permissions/{}",
            encode_segment(tenant),
            encode_segment(namespace),
            encode_segment(role)
        )
    }

    pub fn namespace_publish_rate_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}/publishRate", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn namespace_dispatch_rate_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}/dispatchRate", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn namespace_subscribe_rate_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}/subscribeRate", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn namespace_backlog_quota_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}/backlogQuota", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn namespace_retention_path(&self, tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}/retention", encode_segment(tenant), encode_segment(namespace))
    }

    pub fn topic_publish_rate_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/publishRate", encode_topic_path(topic_path))
    }

    pub fn topic_dispatch_rate_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/dispatchRate", encode_topic_path(topic_path))
    }

    pub fn topic_backlog_quota_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/backlogQuota", encode_topic_path(topic_path))
    }

    pub fn topic_retention_path(&self, domain: &str, topic_path: &str) -> String {
        format!("/admin/v2/{domain}/{}/retention", encode_topic_path(topic_path))
    }

    // ---- Response parsing (version-tolerant) ----

    /// Parse the aggregated topic stats payload. Field names are read
    /// defensively so minor cross-version renames don't break parsing.
    pub fn parse_topic_stats(&self, raw: &serde_json::Value) -> TopicStats {
        let f64_of = |key: &str| raw.get(key).and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let i64_of = |key: &str| raw.get(key).and_then(serde_json::Value::as_i64).unwrap_or(0);

        // Backlog appears as `backlogSize` (bytes) in newer stats; some payloads
        // expose `msgBacklog` per subscription only. Read both tolerantly.
        let backlog_size = raw
            .get("backlogSize")
            .and_then(serde_json::Value::as_i64)
            .or_else(|| raw.get("backlog").and_then(serde_json::Value::as_i64))
            .unwrap_or(0);

        let subscription_count =
            raw.get("subscriptions").and_then(serde_json::Value::as_object).map(|m| m.len() as u32).unwrap_or(0);

        let producer_count = raw
            .get("publishers")
            .and_then(serde_json::Value::as_array)
            .map(|a| a.len() as u32)
            .or_else(|| raw.get("producerCount").and_then(serde_json::Value::as_u64).map(|v| v as u32))
            .unwrap_or(0);

        TopicStats {
            msg_rate_in: f64_of("msgRateIn"),
            msg_rate_out: f64_of("msgRateOut"),
            msg_throughput_in: f64_of("msgThroughputIn"),
            msg_throughput_out: f64_of("msgThroughputOut"),
            storage_size: i64_of("storageSize"),
            backlog_size,
            msg_in_counter: i64_of("msgInCounter"),
            msg_out_counter: i64_of("msgOutCounter"),
            subscription_count,
            producer_count,
            raw: raw.clone(),
        }
    }

    /// Parse the `subscriptions` map from a topic stats payload into a typed list.
    pub fn parse_subscriptions(&self, stats_raw: &serde_json::Value) -> Vec<SubscriptionInfo> {
        let mut by_name = std::collections::BTreeMap::new();
        let has_root_subscriptions = append_subscriptions_from_stats(stats_raw, &mut by_name, false);

        if let Some(partitions) = stats_raw.get("partitions").and_then(serde_json::Value::as_object) {
            for partition in partitions.values() {
                append_subscriptions_from_stats(partition, &mut by_name, has_root_subscriptions);
            }
        }

        by_name.into_values().collect()
    }
}

fn append_subscriptions_from_stats(
    stats_raw: &serde_json::Value,
    by_name: &mut std::collections::BTreeMap<String, SubscriptionInfo>,
    keep_existing_metrics: bool,
) -> bool {
    let Some(subs) = stats_raw.get("subscriptions").and_then(serde_json::Value::as_object) else {
        return false;
    };
    for (name, body) in subs {
        merge_subscription(by_name, subscription_from_stats(name, body), keep_existing_metrics);
    }
    !subs.is_empty()
}

fn merge_subscription(
    by_name: &mut std::collections::BTreeMap<String, SubscriptionInfo>,
    mut incoming: SubscriptionInfo,
    keep_existing_metrics: bool,
) {
    let Some(existing) = by_name.get_mut(&incoming.name) else {
        by_name.insert(incoming.name.clone(), incoming);
        return;
    };

    if existing.sub_type.is_empty() && !incoming.sub_type.is_empty() {
        existing.sub_type = incoming.sub_type;
    }
    if keep_existing_metrics {
        existing.msg_backlog = existing.msg_backlog.max(incoming.msg_backlog);
        existing.msg_rate_out = existing.msg_rate_out.max(incoming.msg_rate_out);
        existing.msg_throughput_out = existing.msg_throughput_out.max(incoming.msg_throughput_out);
    } else {
        existing.msg_backlog = existing.msg_backlog.saturating_add(incoming.msg_backlog);
        existing.msg_rate_out += incoming.msg_rate_out;
        existing.msg_throughput_out += incoming.msg_throughput_out;
    }
    existing.consumers.append(&mut incoming.consumers);
}

fn subscription_from_stats(name: &str, body: &serde_json::Value) -> SubscriptionInfo {
    let consumers = body
        .get("consumers")
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().map(parse_consumer).collect())
        .unwrap_or_default();
    SubscriptionInfo {
        name: name.to_string(),
        sub_type: body.get("type").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        msg_backlog: body.get("msgBacklog").and_then(serde_json::Value::as_i64).unwrap_or(0),
        msg_rate_out: body.get("msgRateOut").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        msg_throughput_out: body.get("msgThroughputOut").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        consumers,
        ..Default::default()
    }
}

fn parse_consumer(v: &serde_json::Value) -> super::super::types::ConsumerInfo {
    super::super::types::ConsumerInfo {
        consumer_name: v.get("consumerName").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        msg_rate_out: v.get("msgRateOut").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        msg_throughput_out: v.get("msgThroughputOut").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        available_permits: v.get("availablePermits").and_then(serde_json::Value::as_i64).unwrap_or(0),
        address: v.get("address").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        client_version: v.get("clientVersion").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
    }
}

fn encode_segment(segment: &str) -> String {
    utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string()
}

fn encode_topic_path(topic_path: &str) -> String {
    let mut parts = topic_path.splitn(3, '/');
    let tenant = parts.next();
    let namespace = parts.next();
    let topic = parts.next();
    match (tenant, namespace, topic) {
        (Some(tenant), Some(namespace), Some(topic)) => {
            format!("{}/{}/{}", encode_segment(tenant), encode_segment(namespace), encode_segment(topic))
        }
        _ => topic_path.split('/').map(encode_segment).collect::<Vec<_>>().join("/"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_version_strings() {
        assert_eq!(PulsarApiProfile::parse_version("3.1.2"), Some(PulsarVersion::V3_1));
        assert_eq!(PulsarApiProfile::parse_version("3.0.7"), Some(PulsarVersion::V3_1));
        assert_eq!(PulsarApiProfile::parse_version("  3.1.0  "), Some(PulsarVersion::V3_1));
    }

    #[test]
    fn parses_verbose_version_strings() {
        assert_eq!(PulsarApiProfile::parse_version("Pulsar version 3.1.2 (rev abc)"), Some(PulsarVersion::V3_1));
    }

    #[test]
    fn unknown_major_returns_none() {
        assert_eq!(PulsarApiProfile::parse_version("4.0.1"), None);
        assert_eq!(PulsarApiProfile::parse_version("not-a-version"), None);
    }

    #[test]
    fn baseline_profile_is_fallback_3_1() {
        let p = PulsarApiProfile::default_baseline();
        assert_eq!(p.version(), PulsarVersion::V3_1);
        assert_eq!(p.detection(), VersionDetection::Fallback);
        assert!(p.capabilities().supports_tenants);
        assert!(!p.capabilities().supports_token_management);
    }

    #[test]
    fn parses_topic_stats_fields() {
        let raw = serde_json::json!({
            "msgRateIn": 12.5,
            "msgRateOut": 7.0,
            "storageSize": 4096,
            "backlogSize": 128,
            "publishers": [{"producerName": "p1"}],
            "subscriptions": {
                "sub-a": {"msgBacklog": 10, "msgRateOut": 1.0, "type": "Shared", "consumers": []},
                "sub-b": {"msgBacklog": 0, "type": "Exclusive", "consumers": []}
            }
        });
        let profile = PulsarApiProfile::default_baseline();
        let stats = profile.parse_topic_stats(&raw);
        assert_eq!(stats.msg_rate_in, 12.5);
        assert_eq!(stats.storage_size, 4096);
        assert_eq!(stats.backlog_size, 128);
        assert_eq!(stats.subscription_count, 2);
        assert_eq!(stats.producer_count, 1);

        let subs = profile.parse_subscriptions(&raw);
        assert_eq!(subs.len(), 2);
    }

    #[test]
    fn parses_partitioned_stats_subscriptions() {
        let raw = serde_json::json!({
            "partitions": {
                "persistent://public/default/orders-partition-0": {
                    "subscriptions": {
                        "sub-a": {
                            "msgBacklog": 3,
                            "msgRateOut": 1.5,
                            "msgThroughputOut": 128.0,
                            "type": "Shared",
                            "consumers": [{ "consumerName": "c0", "address": "/127.0.0.1:1000" }]
                        }
                    }
                },
                "persistent://public/default/orders-partition-1": {
                    "subscriptions": {
                        "sub-a": {
                            "msgBacklog": 5,
                            "msgRateOut": 2.0,
                            "msgThroughputOut": 256.0,
                            "type": "Shared",
                            "consumers": [{ "consumerName": "c1", "address": "/127.0.0.1:1001" }]
                        }
                    }
                }
            }
        });
        let profile = PulsarApiProfile::default_baseline();
        let subs = profile.parse_subscriptions(&raw);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name, "sub-a");
        assert_eq!(subs[0].sub_type, "Shared");
        assert_eq!(subs[0].msg_backlog, 8);
        assert_eq!(subs[0].msg_rate_out, 3.5);
        assert_eq!(subs[0].msg_throughput_out, 384.0);
        assert_eq!(subs[0].consumers.len(), 2);
    }

    #[test]
    fn encodes_each_admin_path_segment() {
        let profile = PulsarApiProfile::default_baseline();
        assert_eq!(profile.tenant_path("tenant with/slash?x"), "/admin/v2/tenants/tenant%20with%2Fslash%3Fx");
        assert_eq!(profile.namespace_path("public", "default space"), "/admin/v2/namespaces/public/default%20space");
        assert_eq!(
            profile.topic_base_path("persistent", "public/default/orders/a?b"),
            "/admin/v2/persistent/public/default/orders%2Fa%3Fb"
        );
        assert_eq!(
            profile.subscription_path("persistent", "public/default/orders/a?b", "sub/role #1"),
            "/admin/v2/persistent/public/default/orders%2Fa%3Fb/subscription/sub%2Frole%20%231"
        );
        assert_eq!(
            profile.topic_permission_role_path("persistent", "public/default/orders", "role/a?b"),
            "/admin/v2/persistent/public/default/orders/permissions/role%2Fa%3Fb"
        );
    }

    #[test]
    fn partitioned_stats_path_encodes_topic_and_requests_partition_detail() {
        let profile = PulsarApiProfile::default_baseline();
        assert_eq!(
            profile.topic_partitioned_stats_path("persistent", "b2b/ec-product-service/goods_status_change", true),
            "/admin/v2/persistent/b2b/ec%2Dproduct%2Dservice/goods%5Fstatus%5Fchange/partitioned-stats?perPartition=true"
        );
        assert_eq!(
            profile.topic_partitioned_stats_path("persistent", "public/default/orders/a?b", true),
            "/admin/v2/persistent/public/default/orders%2Fa%3Fb/partitioned-stats?perPartition=true"
        );
    }

    #[test]
    fn peek_path_encodes_topic_and_subscription_segments() {
        let profile = PulsarApiProfile::default_baseline();
        assert_eq!(
            profile.subscription_peek_path("persistent", "public/default/orders/a?b", "sub/role #1", 3),
            "/admin/v2/persistent/public/default/orders%2Fa%3Fb/subscription/sub%2Frole%20%231/position/3"
        );
    }
}
