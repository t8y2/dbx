//! Product providers (design §5): MCP tools for non-SQL products, one
//! provider per product, each tool shaped after that product's own model.
//!
//! Every provider follows the onboarding checklist: `dbx_<product>_*` names,
//! toolsets with management operations off by default, a declared access
//! level per tool, a declared sub-scope kind (Nacos `namespace`, Consul
//! `datacenter`), business logic reused from `dbx_core::admin::<product>`,
//! and no cluster-level destructive operations. Nacos exposes namespace
//! sub-scopes; Consul uses the datacenter stored on its connection.
//!
//! The server reaches a product through one backend entry point,
//! [`crate::backend::DbxBackend::product_call`], so adding a product does not
//! widen the backend trait: the local backend dispatches to `dbx-core`, other
//! backends report the product as unavailable.

use serde::Deserialize;
use serde_json::{json, Value};

/// Products with an MCP provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Product {
    Nacos,
    Consul,
}

impl Product {
    pub fn as_str(self) -> &'static str {
        match self {
            Product::Nacos => "nacos",
            Product::Consul => "consul",
        }
    }

    /// Sub-scope kind the product declares in the access-control tree.
    /// Consul connections already carry their configured datacenter and do
    /// not expose a separate request-level scope.
    pub fn scope_kind(self) -> Option<&'static str> {
        match self {
            Product::Nacos => Some("namespace"),
            Product::Consul => None,
        }
    }
}

/// One product operation; `args` is the operation's JSON input.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductCall {
    pub product: Product,
    pub operation: &'static str,
    pub args: Value,
}

// ---------------------------------------------------------------------------
// Local dispatch (desktop / standalone binary reading the shared storage)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Args<T> {
    #[serde(flatten)]
    inner: T,
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value::<Args<T>>(args.clone())
        .map(|args| args.inner)
        .map_err(|error| format!("INVALID_ARGUMENTS: {error}"))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// Runs a product operation against `dbx-core`. The caller has already
/// resolved the connection and checked policy, scope and access level.
pub async fn dispatch_local(
    state: &dbx_core::connection::AppState,
    connection_id: &str,
    call: &ProductCall,
) -> Result<Value, String> {
    match call.product {
        Product::Nacos => dispatch_nacos(state, connection_id, call.operation, &call.args).await,
        Product::Consul => dispatch_consul(state, connection_id, call.operation, &call.args).await,
    }
}

async fn dispatch_nacos(
    state: &dbx_core::connection::AppState,
    id: &str,
    operation: &str,
    args: &Value,
) -> Result<Value, String> {
    use dbx_core::nacos::service as nacos;
    use dbx_core::nacos::*;
    match operation {
        "list_namespaces" => to_json(nacos::nacos_list_namespaces_core(state, id).await?),
        "search_configs" => to_json(
            nacos::nacos_search_config_content_core(state, id, parse::<NacosContentSearchRequest>(args)?, |_| async {})
                .await?,
        ),
        "list_configs" => to_json(nacos::nacos_list_configs_core(state, id, parse::<NacosConfigQuery>(args)?).await?),
        "get_config" => to_json(nacos::nacos_get_config_core(state, id, parse::<NacosConfigKey>(args)?).await?),
        "config_history" => {
            to_json(nacos::nacos_list_config_history_core(state, id, parse::<NacosConfigHistoryQuery>(args)?).await?)
        }
        "publish_config" => {
            nacos::nacos_publish_config_core(state, id, parse::<NacosConfigUpsert>(args)?).await?;
            Ok(json!({ "ok": true }))
        }
        "delete_config" => {
            nacos::nacos_delete_config_core(state, id, parse::<NacosConfigKey>(args)?).await?;
            Ok(json!({ "ok": true }))
        }
        "rollback_config" => {
            nacos::nacos_rollback_config_core(state, id, parse::<NacosConfigRollbackRequest>(args)?).await?;
            Ok(json!({ "ok": true }))
        }
        "list_services" => {
            to_json(nacos::nacos_list_services_core(state, id, parse::<NacosServiceQuery>(args)?).await?)
        }
        "get_service" => to_json(nacos::nacos_get_service_core(state, id, parse::<NacosServiceQuery>(args)?).await?),
        "list_instances" => {
            to_json(nacos::nacos_list_instances_core(state, id, parse::<NacosInstanceQuery>(args)?).await?)
        }
        "update_instance" => {
            nacos::nacos_update_instance_core(state, id, parse::<NacosInstanceUpdateRequest>(args)?).await?;
            Ok(json!({ "ok": true }))
        }
        "register_instance" => {
            nacos::nacos_register_instance_core(state, id, parse::<NacosInstanceRegistration>(args)?).await?;
            Ok(json!({ "ok": true }))
        }
        "deregister_instance" => {
            nacos::nacos_deregister_instance_core(state, id, parse::<NacosInstanceRef>(args)?).await?;
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("Unknown Nacos operation `{other}`")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsulKvListArgs {
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    continuation: Option<String>,
}

#[derive(Deserialize)]
struct ConsulKvKeyArgs {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsulKvPutArgs {
    key: String,
    value: String,
    #[serde(default)]
    base64: bool,
    /// Compare-and-set: only write when the key's ModifyIndex matches.
    #[serde(default)]
    cas: Option<i64>,
}

impl ConsulKvPutArgs {
    fn options(&self) -> Result<dbx_core::agent_kv::KvPutOptions, String> {
        use dbx_core::agent_kv::{KvPutOptions, KvWriteMode};
        match self.cas {
            Some(0) => Ok(KvPutOptions { write_mode: Some(KvWriteMode::Create), ..Default::default() }),
            Some(revision) if revision > 0 => {
                Ok(KvPutOptions { expected_mod_revision: Some(revision.into()), ..Default::default() })
            }
            Some(_) => Err("INVALID_ARGUMENTS: cas must be non-negative".to_string()),
            None => Err("CONSUL_CAS_REQUIRED: Pass cas=0 to create, or the current ModifyIndex to update".to_string()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsulKvDeleteArgs {
    key: String,
    #[serde(default)]
    cas: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsulFilterArgs {
    #[serde(default)]
    filter: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsulServiceHealthArgs {
    service: String,
    #[serde(default)]
    passing: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsulMaintenanceArgs {
    service_id: String,
    enable: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// Upper bound for one KV listing page through MCP.
const MAX_KV_LIST: usize = 500;

async fn dispatch_consul(
    state: &dbx_core::connection::AppState,
    id: &str,
    operation: &str,
    args: &Value,
) -> Result<Value, String> {
    use dbx_core::agent_kv::{KvDeleteOptions, KvValue, KvValueEncoding};
    use dbx_core::consul;
    let read_options = |filter: Option<String>| consul::ConsulReadOptions { filter, ..Default::default() };
    match operation {
        "kv_list" => {
            let args = parse::<ConsulKvListArgs>(args)?;
            let limit = args.limit.unwrap_or(100).clamp(1, MAX_KV_LIST);
            to_json(
                consul::consul_list_prefix_core(state, id, &args.prefix, limit, args.continuation.as_deref()).await?,
            )
        }
        "kv_get" => to_json(consul::consul_get_core(state, id, &parse::<ConsulKvKeyArgs>(args)?.key).await?),
        "kv_put" => {
            let args = parse::<ConsulKvPutArgs>(args)?;
            let options = args.options()?;
            let value = KvValue {
                encoding: if args.base64 { KvValueEncoding::Base64 } else { KvValueEncoding::Utf8 },
                data: args.value,
            };
            to_json(consul::consul_put_core(state, id, &args.key, value, options).await?)
        }
        "kv_delete" => {
            let args = parse::<ConsulKvDeleteArgs>(args)?;
            let options = KvDeleteOptions { expected_mod_revision: args.cas.map(Into::into), ..Default::default() };
            to_json(consul::consul_delete_core(state, id, &args.key, options).await?)
        }
        "list_datacenters" => to_json(consul::consul_catalog_datacenters_core(state, id).await?),
        "list_services" => {
            let args = parse::<ConsulFilterArgs>(args)?;
            to_json(consul::consul_catalog_services_core(state, id, read_options(args.filter)).await?)
        }
        "list_nodes" => {
            let args = parse::<ConsulFilterArgs>(args)?;
            to_json(consul::consul_catalog_nodes_core(state, id, read_options(args.filter)).await?)
        }
        "service_health" => {
            let args = parse::<ConsulServiceHealthArgs>(args)?;
            to_json(
                consul::consul_health_service_core(state, id, &args.service, args.passing, read_options(None)).await?,
            )
        }
        "set_maintenance" => {
            let args = parse::<ConsulMaintenanceArgs>(args)?;
            to_json(
                consul::consul_agent_service_maintenance_core(
                    state,
                    id,
                    &args.service_id,
                    args.enable,
                    args.reason.as_deref(),
                )
                .await?,
            )
        }
        other => Err(format!("Unknown Consul operation `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consul_put_preserves_create_only_and_revision_preconditions() {
        use dbx_core::agent_kv::KvWriteMode;
        let create = parse::<ConsulKvPutArgs>(&json!({"key":"new", "value":"v", "cas":0})).unwrap().options().unwrap();
        assert!(matches!(create.write_mode, Some(KvWriteMode::Create)));
        assert!(create.expected_mod_revision.is_none());
        let update = parse::<ConsulKvPutArgs>(&json!({"key":"old", "value":"v", "cas":7})).unwrap().options().unwrap();
        assert_eq!(update.expected_mod_revision.unwrap().as_str(), "7");
        assert!(update.write_mode.is_none());
        for cas in [json!(null), json!(-1)] {
            assert!(parse::<ConsulKvPutArgs>(&json!({"key":"k", "value":"v", "cas":cas})).unwrap().options().is_err());
        }
    }

    #[test]
    fn product_metadata_matches_the_onboarding_spec() {
        assert_eq!(Product::Nacos.scope_kind(), Some("namespace"));
        assert_eq!(Product::Consul.scope_kind(), None);
        assert_eq!(Product::Consul.as_str(), "consul");
    }

    #[test]
    fn arguments_parse_into_core_types_and_report_bad_input() {
        let key = parse::<dbx_core::nacos::NacosConfigKey>(
            &json!({ "dataId": "app.yaml", "group": "DEFAULT_GROUP", "namespace": "dev" }),
        )
        .unwrap();
        assert_eq!((key.data_id.as_str(), key.namespace.as_deref()), ("app.yaml", Some("dev")));
        let error = parse::<dbx_core::nacos::NacosConfigKey>(&json!({ "group": "x" })).unwrap_err();
        assert!(error.starts_with("INVALID_ARGUMENTS"), "{error}");
        let search = parse::<dbx_core::nacos::NacosContentSearchRequest>(&json!({
            "operationId": "op-1", "query": "host", "scope": "currentNamespace"
        }))
        .unwrap();
        assert_eq!(search.operation_id, "op-1");
        let rollback = parse::<dbx_core::nacos::NacosConfigRollbackRequest>(&json!({
            "dataId": "app.yaml", "group": "DEFAULT_GROUP", "historyId": "h1"
        }))
        .unwrap();
        assert_eq!(rollback.history_id, "h1");
        let registration = parse::<dbx_core::nacos::NacosInstanceRegistration>(&json!({
            "serviceName": "api", "ip": "127.0.0.1", "port": 8080
        }))
        .unwrap();
        assert_eq!((registration.service_name, registration.port), ("api".into(), 8080));
        let deregistration = parse::<dbx_core::nacos::NacosInstanceRef>(&json!({
            "serviceName": "api", "ip": "127.0.0.1", "port": 8080
        }))
        .unwrap();
        assert_eq!(deregistration.service_name, "api");
        let put = parse::<ConsulKvPutArgs>(&json!({ "key": "a/b", "value": "1", "cas": 7 })).unwrap();
        assert_eq!((put.key.as_str(), put.cas, put.base64), ("a/b", Some(7), false));
    }
}
