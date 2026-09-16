use std::collections::{BTreeMap, BTreeSet};

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::client::{client_for_state, ConsulClient};
use super::config::ConsulConsistency;
use super::response::{decode_json_response, ensure_success, ConsulResponseMetadata, MAX_COLLECTION_ITEMS};

// Consul lists config entries by kind and does not expose a single inventory endpoint.
const NAMESPACE_CONFIG_ENTRY_KINDS: &[&str] = &[
    "api-gateway",
    "bound-api-gateway",
    "file-system-certificate",
    "http-route",
    "ingress-gateway",
    "inline-certificate",
    "jwt-provider",
    "service-defaults",
    "service-intentions",
    "service-resolver",
    "service-router",
    "service-splitter",
    "tcp-route",
    "terminating-gateway",
];

const PARTITION_CONFIG_ENTRY_KINDS: &[&str] = &[
    "control-plane-request-limit",
    "exported-services",
    "mesh",
    "product-usage",
    "proxy-defaults",
    "rate-limit",
    "sameness-group",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConsulEnterpriseKind {
    Namespace,
    Partition,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulNamespace {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub partition: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
    #[serde(rename = "ACLs", default)]
    pub acls: ConsulNamespaceAcls,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulNamespaceAcls {
    #[serde(default)]
    pub policy_defaults: Vec<serde_json::Value>,
    #[serde(default)]
    pub role_defaults: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulPartition {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub meta: BTreeMap<String, String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "items", rename_all = "camelCase")]
pub enum ConsulEnterpriseList {
    Namespace(Vec<ConsulNamespace>),
    Partition(Vec<ConsulPartition>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "item", rename_all = "camelCase")]
pub enum ConsulEnterpriseItem {
    Namespace(ConsulNamespace),
    Partition(ConsulPartition),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "item", rename_all = "camelCase")]
pub enum ConsulEnterpriseWrite {
    Namespace(ConsulNamespace),
    Partition(ConsulPartition),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulScopeImpact {
    pub services: usize,
    pub nodes: usize,
    pub kv_keys: usize,
    pub health_checks: usize,
    pub sessions: usize,
    pub config_entries: usize,
    pub intentions: usize,
    pub peerings: usize,
    pub namespaces: usize,
    pub acl_tokens: usize,
    pub acl_policies: usize,
    pub acl_roles: usize,
    pub acl_auth_methods: usize,
    pub acl_binding_rules: usize,
    pub complete: bool,
    pub filtered_by_acls: bool,
    pub unavailable_resources: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum ImpactResource {
    Services,
    Nodes,
    KvKeys,
    HealthChecks,
    Sessions,
    ConfigEntries,
    Intentions,
    Peerings,
    Namespaces,
    AclTokens,
    AclPolicies,
    AclRoles,
    AclAuthMethods,
    AclBindingRules,
}

#[derive(Debug)]
struct ImpactInspection {
    count: usize,
    filtered_by_acls: bool,
}

impl ConsulScopeImpact {
    fn record(&mut self, resource: ImpactResource, label: String, result: Result<ImpactInspection, String>) {
        match result {
            Ok(inspection) => {
                let target = match resource {
                    ImpactResource::Services => &mut self.services,
                    ImpactResource::Nodes => &mut self.nodes,
                    ImpactResource::KvKeys => &mut self.kv_keys,
                    ImpactResource::HealthChecks => &mut self.health_checks,
                    ImpactResource::Sessions => &mut self.sessions,
                    ImpactResource::ConfigEntries => &mut self.config_entries,
                    ImpactResource::Intentions => &mut self.intentions,
                    ImpactResource::Peerings => &mut self.peerings,
                    ImpactResource::Namespaces => &mut self.namespaces,
                    ImpactResource::AclTokens => &mut self.acl_tokens,
                    ImpactResource::AclPolicies => &mut self.acl_policies,
                    ImpactResource::AclRoles => &mut self.acl_roles,
                    ImpactResource::AclAuthMethods => &mut self.acl_auth_methods,
                    ImpactResource::AclBindingRules => &mut self.acl_binding_rules,
                };
                if let Some(total) = target.checked_add(inspection.count) {
                    *target = total;
                } else {
                    self.unavailable_resources.push(label);
                }
                self.filtered_by_acls |= inspection.filtered_by_acls;
            }
            Err(_) => self.unavailable_resources.push(label),
        }
    }

    fn finish(mut self) -> Self {
        self.unavailable_resources.sort();
        self.unavailable_resources.dedup();
        self.complete = self.unavailable_resources.is_empty() && !self.filtered_by_acls;
        self
    }
}

pub async fn consul_enterprise_list_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulEnterpriseKind,
) -> Result<ConsulEnterpriseList, String> {
    let client = client_for_state(state, connection_id).await?;
    match kind {
        ConsulEnterpriseKind::Namespace => {
            Ok(ConsulEnterpriseList::Namespace(get_json(&client, "/v1/namespaces", "list namespaces").await?))
        }
        ConsulEnterpriseKind::Partition => {
            Ok(ConsulEnterpriseList::Partition(get_json(&client, "/v1/partitions", "list partitions").await?))
        }
    }
}

pub async fn consul_enterprise_get_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulEnterpriseKind,
    name: &str,
) -> Result<ConsulEnterpriseItem, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&enterprise_path(kind, name))?;
    match kind {
        ConsulEnterpriseKind::Namespace => Ok(ConsulEnterpriseItem::Namespace(
            client.request_json(Method::GET, url, None::<&()>, true, "read namespace").await?,
        )),
        ConsulEnterpriseKind::Partition => Ok(ConsulEnterpriseItem::Partition(
            client.request_json(Method::GET, url, None::<&()>, true, "read partition").await?,
        )),
    }
}

pub async fn consul_enterprise_apply_core(
    state: &AppState,
    connection_id: &str,
    existing_name: Option<&str>,
    item: ConsulEnterpriseWrite,
) -> Result<ConsulEnterpriseItem, String> {
    super::ensure_writable(state, connection_id, "Enterprise scope write").await?;
    let client = client_for_state(state, connection_id).await?;
    match item {
        ConsulEnterpriseWrite::Namespace(value) => {
            Ok(ConsulEnterpriseItem::Namespace(write_namespace(&client, existing_name, value).await?))
        }
        ConsulEnterpriseWrite::Partition(value) => {
            Ok(ConsulEnterpriseItem::Partition(write_partition(&client, existing_name, value).await?))
        }
    }
}

async fn write_namespace(
    client: &ConsulClient,
    existing_name: Option<&str>,
    mut value: ConsulNamespace,
) -> Result<ConsulNamespace, String> {
    value.partition = target_partition(client.partition()).to_string();
    let (method, path) = write_path(ConsulEnterpriseKind::Namespace, existing_name);
    let mut url = client.api_url(&path)?;
    append_enterprise_target(client, &mut url, ConsulEnterpriseKind::Namespace, false);
    client.request_json_unscoped(method, url, Some(&value), "write namespace").await
}

async fn write_partition(
    client: &ConsulClient,
    existing_name: Option<&str>,
    value: ConsulPartition,
) -> Result<ConsulPartition, String> {
    let (method, path) = write_path(ConsulEnterpriseKind::Partition, existing_name);
    let mut url = client.api_url(&path)?;
    append_enterprise_target(client, &mut url, ConsulEnterpriseKind::Partition, false);
    client.request_json_unscoped(method, url, Some(&value), "write partition").await
}

fn target_partition(partition: &str) -> &str {
    if partition.trim().is_empty() {
        "default"
    } else {
        partition
    }
}

pub async fn consul_enterprise_impact_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulEnterpriseKind,
    name: &str,
) -> Result<ConsulScopeImpact, String> {
    let client = client_for_state(state, connection_id).await?;
    inspect_scope_impact(&client, kind, name).await
}

pub async fn consul_enterprise_delete_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulEnterpriseKind,
    name: &str,
) -> Result<ConsulScopeImpact, String> {
    super::ensure_writable(state, connection_id, "Enterprise scope delete").await?;
    let impact = consul_enterprise_impact_core(state, connection_id, kind, name).await?;
    if !impact.complete {
        return Err(
            "CONSUL_IMPACT_INCOMPLETE: scoped resources could not be enumerated completely; delete blocked".to_string()
        );
    }
    let client = client_for_state(state, connection_id).await?;
    let mut url = client.api_url(&enterprise_path(kind, name))?;
    append_enterprise_target(&client, &mut url, kind, false);
    ensure_success(client.send(Method::DELETE, url, None).await?, "delete Enterprise scope", client.token()).await?;
    Ok(impact)
}

async fn get_json<T: serde::de::DeserializeOwned>(
    client: &ConsulClient,
    path: &str,
    action: &str,
) -> Result<T, String> {
    let url = client.api_url(path)?;
    client.request_json(Method::GET, url, None::<&()>, true, action).await
}

async fn inspect_scope_impact(
    client: &ConsulClient,
    kind: ConsulEnterpriseKind,
    name: &str,
) -> Result<ConsulScopeImpact, String> {
    if name.trim().is_empty() {
        return Err("CONSUL_INVALID_REQUEST: Enterprise scope name is required".to_string());
    }

    let mut impact = ConsulScopeImpact::default();
    match kind {
        ConsulEnterpriseKind::Namespace => {
            inspect_namespace_resources(client, name, client.partition(), &mut impact).await;
        }
        ConsulEnterpriseKind::Partition => {
            match inspect_partition_namespaces(client, name).await {
                Ok((namespaces, filtered)) => {
                    impact.record(
                        ImpactResource::Namespaces,
                        "namespaces".to_string(),
                        Ok(ImpactInspection { count: namespaces.len(), filtered_by_acls: filtered }),
                    );
                    // Every partition owns a default namespace. Its absence means the list cannot prove completeness,
                    // even if an older Consul version omitted the ACL-filtered response header.
                    if !namespaces.contains("default") {
                        impact.unavailable_resources.push("namespaces:default".to_string());
                    }
                    for namespace in namespaces {
                        inspect_namespace_resources(client, &namespace, name, &mut impact).await;
                    }
                }
                Err(_) => impact.unavailable_resources.push("namespaces".to_string()),
            }

            record_inspection(
                client,
                &mut impact,
                ImpactResource::Nodes,
                "nodes",
                "/v1/catalog/nodes",
                name,
                None,
                &[],
                false,
            )
            .await;
            record_inspection(
                client,
                &mut impact,
                ImpactResource::Peerings,
                "peerings",
                "/v1/peerings",
                name,
                None,
                &[],
                false,
            )
            .await;
            for config_kind in PARTITION_CONFIG_ENTRY_KINDS {
                record_inspection(
                    client,
                    &mut impact,
                    ImpactResource::ConfigEntries,
                    &format!("configEntries:{config_kind}"),
                    &format!("/v1/config/{config_kind}"),
                    name,
                    Some("default"),
                    &[],
                    false,
                )
                .await;
            }
        }
    }
    Ok(impact.finish())
}

async fn inspect_namespace_resources(
    client: &ConsulClient,
    namespace: &str,
    partition: &str,
    impact: &mut ConsulScopeImpact,
) {
    let resources = [
        (ImpactResource::Services, "services", "/v1/catalog/services", false),
        (ImpactResource::KvKeys, "kvKeys", "/v1/kv/", true),
        (ImpactResource::HealthChecks, "healthChecks", "/v1/health/state/any", false),
        (ImpactResource::Sessions, "sessions", "/v1/session/list", false),
        (ImpactResource::Intentions, "intentions", "/v1/connect/intentions", false),
        (ImpactResource::AclTokens, "aclTokens", "/v1/acl/tokens", false),
        (ImpactResource::AclPolicies, "aclPolicies", "/v1/acl/policies", false),
        (ImpactResource::AclRoles, "aclRoles", "/v1/acl/roles", false),
        (ImpactResource::AclAuthMethods, "aclAuthMethods", "/v1/acl/auth-methods", false),
        (ImpactResource::AclBindingRules, "aclBindingRules", "/v1/acl/binding-rules", false),
    ];
    for (resource, label, path, empty_on_not_found) in resources {
        let query = if matches!(resource, ImpactResource::KvKeys) { &[("keys", "")][..] } else { &[][..] };
        record_inspection(
            client,
            impact,
            resource,
            &scoped_label(label, namespace),
            path,
            partition,
            Some(namespace),
            query,
            empty_on_not_found,
        )
        .await;
    }
    for config_kind in NAMESPACE_CONFIG_ENTRY_KINDS {
        record_inspection(
            client,
            impact,
            ImpactResource::ConfigEntries,
            &scoped_label(&format!("configEntries:{config_kind}"), namespace),
            &format!("/v1/config/{config_kind}"),
            partition,
            Some(namespace),
            &[],
            false,
        )
        .await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn record_inspection(
    client: &ConsulClient,
    impact: &mut ConsulScopeImpact,
    resource: ImpactResource,
    label: &str,
    path: &str,
    partition: &str,
    namespace: Option<&str>,
    query: &[(&str, &str)],
    empty_on_not_found: bool,
) {
    let result = impact_get(client, path, partition, namespace, query, empty_on_not_found).await;
    impact.record(resource, label.to_string(), result);
}

async fn impact_get(
    client: &ConsulClient,
    path: &str,
    partition: &str,
    namespace: Option<&str>,
    extra_query: &[(&str, &str)],
    empty_on_not_found: bool,
) -> Result<ImpactInspection, String> {
    let mut url = client.api_url(path)?;
    append_explicit_scope(client, &mut url, partition, namespace, true);
    for (key, value) in extra_query {
        url.query_pairs_mut().append_pair(key, value);
    }
    let response = client.send(Method::GET, url, None).await?;
    let filtered = ConsulResponseMetadata::from_response(&response).filtered_by_acls.unwrap_or(false);
    if is_empty_not_found(response.status(), empty_on_not_found) {
        return Ok(ImpactInspection { count: 0, filtered_by_acls: filtered });
    }
    let response = ensure_success(response, "inspect scoped resources", client.token()).await?;
    let value = decode_json_response::<serde_json::Value>(response, "inspect scoped resources").await?;
    let count = count_collection(&value)?;
    Ok(ImpactInspection { count, filtered_by_acls: filtered })
}

async fn inspect_partition_namespaces(
    client: &ConsulClient,
    partition: &str,
) -> Result<(BTreeSet<String>, bool), String> {
    let mut url = client.api_url("/v1/namespaces")?;
    append_explicit_scope(client, &mut url, partition, None, true);
    let response = ensure_success(
        client.send(Method::GET, url, None).await?,
        "list namespaces for partition impact",
        client.token(),
    )
    .await?;
    let filtered = ConsulResponseMetadata::from_response(&response).filtered_by_acls.unwrap_or(false);
    let value = decode_json_response::<serde_json::Value>(response, "list namespaces for partition impact").await?;
    let items = value
        .as_array()
        .ok_or_else(|| "CONSUL_INVALID_RESPONSE: namespace impact response must be an array".to_string())?;
    if items.len() > MAX_COLLECTION_ITEMS {
        return Err(format!("CONSUL_RESPONSE_TOO_LARGE: impact response exceeds {MAX_COLLECTION_ITEMS} items"));
    }
    let mut namespaces = BTreeSet::new();
    for item in items {
        let name = item
            .get("Name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "CONSUL_INVALID_RESPONSE: namespace impact item is missing Name".to_string())?;
        if !namespaces.insert(name.to_string()) {
            return Err(format!("CONSUL_INVALID_RESPONSE: duplicate namespace {name:?} in impact response"));
        }
    }
    Ok((namespaces, filtered))
}

fn count_collection(value: &serde_json::Value) -> Result<usize, String> {
    let count = match value {
        serde_json::Value::Array(items) => items.len(),
        serde_json::Value::Object(items) => items.len(),
        _ => return Err("CONSUL_INVALID_RESPONSE: impact response must be an array or object".to_string()),
    };
    if count > MAX_COLLECTION_ITEMS {
        return Err(format!("CONSUL_RESPONSE_TOO_LARGE: impact response exceeds {MAX_COLLECTION_ITEMS} items"));
    }
    Ok(count)
}

fn is_empty_not_found(status: reqwest::StatusCode, empty_on_not_found: bool) -> bool {
    empty_on_not_found && status == reqwest::StatusCode::NOT_FOUND
}

fn append_explicit_scope(
    client: &ConsulClient,
    url: &mut reqwest::Url,
    partition: &str,
    namespace: Option<&str>,
    read: bool,
) {
    let mut query = url.query_pairs_mut();
    if !client.datacenter().is_empty() {
        query.append_pair("dc", client.datacenter());
    }
    if !partition.is_empty() {
        query.append_pair("partition", partition);
    }
    if let Some(namespace) = namespace.filter(|namespace| !namespace.is_empty()) {
        query.append_pair("ns", namespace);
    }
    if read {
        match client.config().consistency {
            ConsulConsistency::Default => {}
            ConsulConsistency::Stale => {
                query.append_pair("stale", "");
            }
            ConsulConsistency::Consistent => {
                query.append_pair("consistent", "");
            }
        }
    }
}

fn append_enterprise_target(client: &ConsulClient, url: &mut reqwest::Url, kind: ConsulEnterpriseKind, read: bool) {
    let partition = match kind {
        ConsulEnterpriseKind::Namespace => client.partition(),
        ConsulEnterpriseKind::Partition => "",
    };
    append_explicit_scope(client, url, partition, None, read);
}

fn scoped_label(label: &str, namespace: &str) -> String {
    format!("{label}@namespace:{namespace}")
}

fn enterprise_path(kind: ConsulEnterpriseKind, name: &str) -> String {
    let name = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    match kind {
        ConsulEnterpriseKind::Namespace => format!("/v1/namespace/{name}"),
        ConsulEnterpriseKind::Partition => format!("/v1/partition/{name}"),
    }
}

fn write_path(kind: ConsulEnterpriseKind, existing_name: Option<&str>) -> (Method, String) {
    match existing_name {
        Some(name) => (Method::PUT, enterprise_path(kind, name)),
        None => (
            Method::PUT,
            match kind {
                ConsulEnterpriseKind::Namespace => "/v1/namespace",
                ConsulEnterpriseKind::Partition => "/v1/partition",
            }
            .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{serve_once, test_client as fixture_client};
    use super::*;
    use reqwest::Url;

    #[test]
    fn enterprise_paths_encode_names() {
        assert_eq!(enterprise_path(ConsulEnterpriseKind::Namespace, "team/a"), "/v1/namespace/team%2Fa");
    }

    #[test]
    fn namespace_acl_defaults_round_trip_with_the_official_nested_shape() {
        let value = serde_json::json!({
            "Name": "team-a",
            "Partition": "payments",
            "ACLs": {
                "PolicyDefaults": [{ "Name": "node-read" }],
                "RoleDefaults": [{ "ID": "role-1" }]
            }
        });
        let namespace: ConsulNamespace = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(namespace.acls.policy_defaults.len(), 1);
        assert_eq!(namespace.acls.role_defaults.len(), 1);
        assert_eq!(namespace.partition, "payments");
        let serialized = serde_json::to_value(namespace).unwrap();
        assert_eq!(serialized["ACLs"], value["ACLs"]);
    }

    #[test]
    fn namespace_write_partition_is_explicit_and_defaults_safely() {
        assert_eq!(target_partition("partition-a"), "partition-a");
        assert_eq!(target_partition(""), "default");
        assert_eq!(target_partition("   "), "default");
        assert_eq!(
            write_path(ConsulEnterpriseKind::Namespace, Some("team/a")),
            (Method::PUT, "/v1/namespace/team%2Fa".to_string())
        );
    }

    #[tokio::test]
    async fn namespace_create_uses_partition_body_and_excludes_current_namespace() {
        let response_body = r#"{"Name":"team-b","Partition":"partition-a","Description":"","Meta":{},"ACLs":{}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
            response_body.len()
        );
        let (url, request_rx) = serve_once(response).await;
        let client = fixture_client(url).await;
        let written =
            write_namespace(&client, None, ConsulNamespace { name: "team-b".to_string(), ..Default::default() })
                .await
                .unwrap();
        assert_eq!(written.partition, "partition-a");

        let request = request_rx.await.unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("PUT /proxy/v1/namespace?dc=dc1&partition=partition-a HTTP/1.1"));
        assert!(!headers.contains("ns="));
        assert!(headers.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(headers.to_ascii_lowercase().contains("x-consul-token: fixture-token"));
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["Name"], "team-b");
        assert_eq!(body["Partition"], "partition-a");
    }

    #[tokio::test]
    async fn explicit_impact_scope_uses_the_target_without_wildcards() {
        let client = test_client().await;
        let mut url = client.api_url("/v1/catalog/services").unwrap();
        append_explicit_scope(&client, &mut url, "target-partition", Some("target-namespace"), true);
        let pairs: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("dc").map(String::as_str), Some("dc1"));
        assert_eq!(pairs.get("partition").map(String::as_str), Some("target-partition"));
        assert_eq!(pairs.get("ns").map(String::as_str), Some("target-namespace"));
        assert!(pairs.contains_key("consistent"));
        assert!(!url.as_str().contains('*'));
        assert!(!url.as_str().contains("configured-namespace"));
        assert!(!url.as_str().contains("configured-partition"));
    }

    #[tokio::test]
    async fn enterprise_delete_target_does_not_append_the_connection_namespace() {
        let client = test_client().await;
        let mut namespace_url = client.api_url("/v1/namespace/team-a").unwrap();
        append_enterprise_target(&client, &mut namespace_url, ConsulEnterpriseKind::Namespace, false);
        assert_eq!(namespace_url.query(), Some("dc=dc1&partition=configured-partition"));

        let mut partition_url = client.api_url("/v1/partition/team-a").unwrap();
        append_enterprise_target(&client, &mut partition_url, ConsulEnterpriseKind::Partition, false);
        assert_eq!(partition_url.query(), Some("dc=dc1"));
    }

    #[test]
    fn impact_is_incomplete_when_any_result_is_filtered_or_unavailable() {
        let mut impact = ConsulScopeImpact::default();
        impact.record(
            ImpactResource::Services,
            "services".to_string(),
            Ok(ImpactInspection { count: 2, filtered_by_acls: true }),
        );
        impact.record(ImpactResource::Sessions, "sessions".to_string(), Err("forbidden".to_string()));
        let impact = impact.finish();
        assert_eq!(impact.services, 2);
        assert!(impact.filtered_by_acls);
        assert_eq!(impact.unavailable_resources, vec!["sessions"]);
        assert!(!impact.complete);
    }

    #[test]
    fn impact_is_complete_only_after_all_recorded_results_are_unfiltered() {
        let mut impact = ConsulScopeImpact::default();
        impact.record(
            ImpactResource::KvKeys,
            "kvKeys".to_string(),
            Ok(ImpactInspection { count: 3, filtered_by_acls: false }),
        );
        impact.record(
            ImpactResource::ConfigEntries,
            "configEntries".to_string(),
            Ok(ImpactInspection { count: 4, filtered_by_acls: false }),
        );
        let impact = impact.finish();
        assert_eq!(impact.kv_keys, 3);
        assert_eq!(impact.config_entries, 4);
        assert!(impact.complete);
    }

    #[test]
    fn impact_collection_count_rejects_non_collections_and_excess_items() {
        assert!(count_collection(&serde_json::json!(false)).is_err());
        let oversized = serde_json::Value::Array(vec![serde_json::Value::Null; MAX_COLLECTION_ITEMS + 1]);
        assert!(count_collection(&oversized).is_err());
    }

    #[test]
    fn config_entry_inventory_covers_namespace_and_partition_scopes_without_duplicates() {
        let all = NAMESPACE_CONFIG_ENTRY_KINDS
            .iter()
            .chain(PARTITION_CONFIG_ENTRY_KINDS.iter())
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(all.len(), NAMESPACE_CONFIG_ENTRY_KINDS.len() + PARTITION_CONFIG_ENTRY_KINDS.len());
        for required in [
            "service-defaults",
            "service-intentions",
            "api-gateway",
            "bound-api-gateway",
            "jwt-provider",
            "proxy-defaults",
            "mesh",
            "exported-services",
            "sameness-group",
        ] {
            assert!(all.contains(required), "missing config entry kind {required}");
        }
    }

    #[test]
    fn only_explicitly_empty_collections_treat_not_found_as_zero() {
        assert!(is_empty_not_found(reqwest::StatusCode::NOT_FOUND, true));
        assert!(!is_empty_not_found(reqwest::StatusCode::NOT_FOUND, false));
        assert!(!is_empty_not_found(reqwest::StatusCode::FORBIDDEN, true));
    }

    async fn test_client() -> ConsulClient {
        test_client_at(Url::parse("https://consul.example/proxy").unwrap()).await
    }

    async fn test_client_at(base_url: Url) -> ConsulClient {
        ConsulClient::new(super::super::config::ConsulConfig {
            base_url,
            token: String::new(),
            datacenter: "dc1".to_string(),
            namespace: "configured-namespace".to_string(),
            partition: "configured-partition".to_string(),
            consistency: ConsulConsistency::Consistent,
            tls_skip_verify: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            connect_timeout_secs: 5,
            request_timeout_secs: 30,
            connect_override: None,
            operator_snapshot_restore_enabled: false,
            operator_autopilot_write_enabled: false,
            operator_raft_write_enabled: false,
            operator_keyring_write_enabled: false,
            operator_license_write_enabled: false,
            agent_target: None,
        })
        .await
        .unwrap()
    }
}
