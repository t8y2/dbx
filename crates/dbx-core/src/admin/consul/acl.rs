use std::fmt;

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::connection::AppState;

use super::client::{client_for_state, ConsulClient};
use super::response::{decode_json_response, ConsulResponseMetadata};

/// Sensitive Consul value. Deliberately does not implement `Debug`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConsulSecret(String);

impl ConsulSecret {
    pub fn expose_once(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConsulAclKind {
    Token,
    Policy,
    Role,
    AuthMethod,
    BindingRule,
    TemplatedPolicy,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclLink {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclToken {
    #[serde(rename = "AccessorID", default)]
    pub accessor_id: String,
    #[serde(rename = "SecretID", default, skip_serializing_if = "Option::is_none")]
    pub secret_id: Option<ConsulSecret>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub auth_method: String,
    #[serde(default)]
    pub policies: Vec<ConsulAclLink>,
    #[serde(default)]
    pub roles: Vec<ConsulAclLink>,
    #[serde(default)]
    pub service_identities: Vec<serde_json::Value>,
    #[serde(default)]
    pub node_identities: Vec<serde_json::Value>,
    #[serde(default)]
    pub templated_policies: Vec<serde_json::Value>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclPolicy {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub rules: String,
    #[serde(default)]
    pub datacenters: Vec<String>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclRole {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub policies: Vec<ConsulAclLink>,
    #[serde(default)]
    pub service_identities: Vec<serde_json::Value>,
    #[serde(default)]
    pub node_identities: Vec<serde_json::Value>,
    #[serde(default)]
    pub templated_policies: Vec<serde_json::Value>,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclAuthMethod {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "Type", default)]
    pub method_type: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "MaxTokenTTL", default)]
    pub max_token_ttl: String,
    #[serde(default)]
    pub token_locality: String,
    #[serde(default)]
    pub config: serde_json::Value,
}

impl fmt::Debug for ConsulAclAuthMethod {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConsulAclAuthMethod")
            .field("name", &self.name)
            .field("method_type", &self.method_type)
            .field("display_name", &self.display_name)
            .field("description", &self.description)
            .field("max_token_ttl", &self.max_token_ttl)
            .field("token_locality", &self.token_locality)
            .field("config", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclBindingRule {
    #[serde(rename = "ID", default)]
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub auth_method: String,
    #[serde(default)]
    pub selector: String,
    #[serde(default)]
    pub bind_type: String,
    #[serde(default)]
    pub bind_name: String,
    #[serde(default)]
    pub bind_vars: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclTemplatedPolicy {
    #[serde(default)]
    pub template_name: String,
    #[serde(default)]
    pub schema: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "items", rename_all = "camelCase")]
pub enum ConsulAclList {
    Token(Vec<ConsulAclToken>),
    Policy(Vec<ConsulAclPolicy>),
    Role(Vec<ConsulAclRole>),
    AuthMethod(Vec<ConsulAclAuthMethod>),
    BindingRule(Vec<ConsulAclBindingRule>),
    TemplatedPolicy(Vec<ConsulAclTemplatedPolicy>),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "item", rename_all = "camelCase")]
pub enum ConsulAclItem {
    Token(ConsulAclToken),
    Policy(ConsulAclPolicy),
    Role(ConsulAclRole),
    AuthMethod(ConsulAclAuthMethod),
    BindingRule(ConsulAclBindingRule),
    TemplatedPolicy(ConsulAclTemplatedPolicy),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "item", rename_all = "camelCase")]
pub enum ConsulAclWrite {
    Token(ConsulAclToken),
    Policy(ConsulAclPolicy),
    Role(ConsulAclRole),
    AuthMethod(ConsulAclAuthMethod),
    BindingRule(ConsulAclBindingRule),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulAclReferences {
    pub token_accessor_ids: Vec<String>,
    pub role_ids: Vec<String>,
    pub binding_rule_ids: Vec<String>,
    pub complete: bool,
    pub filtered_by_acls: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulAclTokenClone {
    #[serde(default)]
    pub description: String,
}

pub async fn consul_acl_token_self_core(state: &AppState, connection_id: &str) -> Result<ConsulAclToken, String> {
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url("/v1/acl/token/self")?;
    client.request_json(Method::GET, url, None::<&()>, true, "read current ACL token").await.map(without_token_secret)
}

pub async fn consul_acl_token_clone_core(
    state: &AppState,
    connection_id: &str,
    accessor_id: &str,
    request: ConsulAclTokenClone,
) -> Result<ConsulAclToken, String> {
    super::ensure_writable(state, connection_id, "ACL token clone").await?;
    let client = client_for_state(state, connection_id).await?;
    let accessor_id = percent_encoding::utf8_percent_encode(accessor_id, percent_encoding::NON_ALPHANUMERIC);
    let url = client.api_url(&format!("/v1/acl/token/{accessor_id}/clone"))?;
    client.request_json(Method::PUT, url, Some(&request), false, "clone ACL token").await
}

pub async fn consul_acl_list_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulAclKind,
) -> Result<ConsulAclList, String> {
    let client = client_for_state(state, connection_id).await?;
    match kind {
        ConsulAclKind::Token => Ok(ConsulAclList::Token(
            list::<ConsulAclToken>(&client, "/v1/acl/tokens", "list ACL tokens")
                .await?
                .into_iter()
                .map(without_token_secret)
                .collect(),
        )),
        ConsulAclKind::Policy => {
            Ok(ConsulAclList::Policy(list(&client, "/v1/acl/policies", "list ACL policies").await?))
        }
        ConsulAclKind::Role => Ok(ConsulAclList::Role(list(&client, "/v1/acl/roles", "list ACL roles").await?)),
        ConsulAclKind::AuthMethod => Ok(ConsulAclList::AuthMethod(
            list::<ConsulAclAuthMethod>(&client, "/v1/acl/auth-methods", "list ACL auth methods")
                .await?
                .into_iter()
                .map(without_auth_method_secrets)
                .collect(),
        )),
        ConsulAclKind::BindingRule => {
            Ok(ConsulAclList::BindingRule(list(&client, "/v1/acl/binding-rules", "list ACL binding rules").await?))
        }
        ConsulAclKind::TemplatedPolicy => Ok(ConsulAclList::TemplatedPolicy(
            list(&client, "/v1/acl/templated-policies", "list ACL templated policies").await?,
        )),
    }
}

pub async fn consul_acl_get_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulAclKind,
    id: &str,
) -> Result<ConsulAclItem, String> {
    let client = client_for_state(state, connection_id).await?;
    if kind == ConsulAclKind::TemplatedPolicy {
        return list::<ConsulAclTemplatedPolicy>(&client, "/v1/acl/templated-policies", "list ACL templated policies")
            .await?
            .into_iter()
            .find(|policy| policy.template_name == id)
            .map(ConsulAclItem::TemplatedPolicy)
            .ok_or_else(|| "CONSUL_ACL_NOT_FOUND: Templated policy not found".to_string());
    }
    let url = client.api_url(&item_path(kind, id)?)?;
    match kind {
        ConsulAclKind::Token => Ok(ConsulAclItem::Token(without_token_secret(
            client.request_json(Method::GET, url, None::<&()>, true, "read ACL token").await?,
        ))),
        ConsulAclKind::Policy => Ok(ConsulAclItem::Policy(
            client.request_json(Method::GET, url, None::<&()>, true, "read ACL policy").await?,
        )),
        ConsulAclKind::Role => {
            Ok(ConsulAclItem::Role(client.request_json(Method::GET, url, None::<&()>, true, "read ACL role").await?))
        }
        ConsulAclKind::AuthMethod => Ok(ConsulAclItem::AuthMethod(without_auth_method_secrets(
            client.request_json(Method::GET, url, None::<&()>, true, "read ACL auth method").await?,
        ))),
        ConsulAclKind::BindingRule => Ok(ConsulAclItem::BindingRule(
            client.request_json(Method::GET, url, None::<&()>, true, "read ACL binding rule").await?,
        )),
        ConsulAclKind::TemplatedPolicy => unreachable!("templated policy reads are handled by the collection"),
    }
}

pub async fn consul_acl_apply_core(
    state: &AppState,
    connection_id: &str,
    id: Option<&str>,
    value: ConsulAclWrite,
) -> Result<ConsulAclItem, String> {
    super::ensure_writable(state, connection_id, "ACL write").await?;
    let client = client_for_state(state, connection_id).await?;
    match value {
        ConsulAclWrite::Token(item) => Ok(ConsulAclItem::Token(apply(&client, ConsulAclKind::Token, id, &item).await?)),
        ConsulAclWrite::Policy(item) => {
            Ok(ConsulAclItem::Policy(apply(&client, ConsulAclKind::Policy, id, &item).await?))
        }
        ConsulAclWrite::Role(item) => Ok(ConsulAclItem::Role(apply(&client, ConsulAclKind::Role, id, &item).await?)),
        ConsulAclWrite::AuthMethod(mut item) => {
            if let Some(id) = id {
                let url = client.api_url(&item_path(ConsulAclKind::AuthMethod, id)?)?;
                let existing: ConsulAclAuthMethod = client
                    .request_json(Method::GET, url, None::<&()>, true, "read ACL auth method before update")
                    .await?;
                merge_missing_sensitive_config(&mut item.config, &existing.config);
            }
            Ok(ConsulAclItem::AuthMethod(without_auth_method_secrets(
                apply(&client, ConsulAclKind::AuthMethod, id, &item).await?,
            )))
        }
        ConsulAclWrite::BindingRule(item) => {
            Ok(ConsulAclItem::BindingRule(apply(&client, ConsulAclKind::BindingRule, id, &item).await?))
        }
    }
}

pub async fn consul_acl_delete_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulAclKind,
    id: &str,
) -> Result<ConsulAclReferences, String> {
    super::ensure_writable(state, connection_id, "ACL delete").await?;
    let references = consul_acl_references_core(state, connection_id, kind, id).await?;
    if !references.complete {
        return Err("CONSUL_IMPACT_INCOMPLETE: ACL references could not be enumerated completely".to_string());
    }
    let client = client_for_state(state, connection_id).await?;
    let url = client.api_url(&item_path(kind, id)?)?;
    client.send_json(Method::DELETE, url, None::<&()>, false, "delete ACL resource").await?;
    Ok(references)
}

pub async fn consul_acl_references_core(
    state: &AppState,
    connection_id: &str,
    kind: ConsulAclKind,
    id: &str,
) -> Result<ConsulAclReferences, String> {
    let client = client_for_state(state, connection_id).await?;
    let tokens = if matches!(kind, ConsulAclKind::Policy | ConsulAclKind::Role | ConsulAclKind::AuthMethod) {
        list_with_meta::<ConsulAclToken>(&client, "/v1/acl/tokens", "list ACL token references").await
    } else {
        Ok((Vec::new(), false))
    };
    let roles = if kind == ConsulAclKind::Policy {
        list_with_meta::<ConsulAclRole>(&client, "/v1/acl/roles", "list ACL role references").await
    } else {
        Ok((Vec::new(), false))
    };
    let binding_rules = if kind == ConsulAclKind::AuthMethod {
        list_with_meta::<ConsulAclBindingRule>(&client, "/v1/acl/binding-rules", "list ACL binding rule references")
            .await
    } else {
        Ok((Vec::new(), false))
    };
    let complete = tokens.is_ok() && roles.is_ok() && binding_rules.is_ok();
    let (tokens, token_filtered) = tokens.unwrap_or_default();
    let (roles, role_filtered) = roles.unwrap_or_default();
    let (binding_rules, binding_rule_filtered) = binding_rules.unwrap_or_default();
    let mut result = ConsulAclReferences {
        complete: complete && !(token_filtered || role_filtered || binding_rule_filtered),
        filtered_by_acls: token_filtered || role_filtered || binding_rule_filtered,
        ..Default::default()
    };
    match kind {
        ConsulAclKind::Policy => {
            result.token_accessor_ids = tokens
                .iter()
                .filter(|token| token.policies.iter().any(|link| link.id == id || link.name == id))
                .map(|token| token.accessor_id.clone())
                .collect();
            result.role_ids = roles
                .iter()
                .filter(|role| role.policies.iter().any(|link| link.id == id || link.name == id))
                .map(|role| role.id.clone())
                .collect();
        }
        ConsulAclKind::Role => {
            result.token_accessor_ids = tokens
                .iter()
                .filter(|token| token.roles.iter().any(|link| link.id == id || link.name == id))
                .map(|token| token.accessor_id.clone())
                .collect()
        }
        ConsulAclKind::AuthMethod => {
            result.token_accessor_ids =
                tokens.iter().filter(|token| token.auth_method == id).map(|token| token.accessor_id.clone()).collect();
            result.binding_rule_ids =
                binding_rules.iter().filter(|rule| rule.auth_method == id).map(|rule| rule.id.clone()).collect();
        }
        _ => {}
    }
    Ok(result)
}

async fn list<T: serde::de::DeserializeOwned>(
    client: &ConsulClient,
    path: &str,
    action: &str,
) -> Result<Vec<T>, String> {
    let url = client.api_url(path)?;
    client.request_json(Method::GET, url, None::<&()>, true, action).await
}

async fn list_with_meta<T: serde::de::DeserializeOwned>(
    client: &ConsulClient,
    path: &str,
    action: &str,
) -> Result<(Vec<T>, bool), String> {
    let url = client.api_url(path)?;
    let response = client.send_json(Method::GET, url, None::<&()>, true, action).await?;
    let filtered = ConsulResponseMetadata::from_response(&response).filtered_by_acls.unwrap_or(false);
    let items = decode_json_response(response, action).await?;
    Ok((items, filtered))
}

async fn apply<T: Serialize + serde::de::DeserializeOwned>(
    client: &ConsulClient,
    kind: ConsulAclKind,
    id: Option<&str>,
    item: &T,
) -> Result<T, String> {
    let (method, path) = if let Some(id) = id {
        (Method::PUT, item_path(kind, id)?)
    } else {
        (Method::PUT, collection_create_path(kind)?.to_string())
    };
    let url = client.api_url(&path)?;
    client.request_json(method, url, Some(item), false, "write ACL resource").await
}

fn without_token_secret(mut token: ConsulAclToken) -> ConsulAclToken {
    token.secret_id = None;
    token
}

fn without_auth_method_secrets(mut method: ConsulAclAuthMethod) -> ConsulAclAuthMethod {
    redact_sensitive_config(&mut method.config);
    method
}

fn redact_sensitive_config(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            object.retain(|key, _| !is_sensitive_config_key(key));
            for value in object.values_mut() {
                redact_sensitive_config(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_sensitive_config(value);
            }
        }
        _ => {}
    }
}

fn is_sensitive_config_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("secret")
        || key.contains("password")
        || key.contains("passphrase")
        || key.contains("token")
        || key == "jwt"
        || key.ends_with("jwt")
        || key == "bootstrap"
}

fn merge_missing_sensitive_config(target: &mut serde_json::Value, existing: &serde_json::Value) {
    let (serde_json::Value::Object(target), serde_json::Value::Object(existing)) = (target, existing) else {
        return;
    };
    for (key, existing_value) in existing {
        if is_sensitive_config_key(key) {
            target.entry(key.clone()).or_insert_with(|| existing_value.clone());
        } else if let Some(target_value) = target.get_mut(key) {
            merge_missing_sensitive_config(target_value, existing_value);
        }
    }
}

fn collection_create_path(kind: ConsulAclKind) -> Result<&'static str, String> {
    match kind {
        ConsulAclKind::Token => Ok("/v1/acl/token"),
        ConsulAclKind::Policy => Ok("/v1/acl/policy"),
        ConsulAclKind::Role => Ok("/v1/acl/role"),
        ConsulAclKind::AuthMethod => Ok("/v1/acl/auth-method"),
        ConsulAclKind::BindingRule => Ok("/v1/acl/binding-rule"),
        ConsulAclKind::TemplatedPolicy => Err("CONSUL_UNSUPPORTED: templated policies are read-only".to_string()),
    }
}

fn item_path(kind: ConsulAclKind, id: &str) -> Result<String, String> {
    let segment = percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC);
    Ok(format!("{}/{}", collection_create_path(kind)?, segment))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acl_paths_are_safe() {
        assert_eq!(item_path(ConsulAclKind::Policy, "team/a").unwrap(), "/v1/acl/policy/team%2Fa");
        assert!(item_path(ConsulAclKind::TemplatedPolicy, "x").is_err());
    }

    #[test]
    fn ordinary_token_reads_do_not_serialize_secret_id() {
        let token = without_token_secret(ConsulAclToken {
            accessor_id: "accessor".into(),
            secret_id: Some(ConsulSecret("connection-token".into())),
            ..Default::default()
        });
        let serialized = serde_json::to_string(&token).unwrap();
        assert!(!serialized.contains("connection-token"));
        assert!(!serialized.contains("SecretID"));
    }

    #[test]
    fn auth_method_output_and_debug_redact_nested_secrets() {
        let method = without_auth_method_secrets(ConsulAclAuthMethod {
            name: "oidc".into(),
            config: serde_json::json!({
                "OIDCClientID": "public-client",
                "OIDCClientSecret": "top-secret",
                "ServiceAccountJWT": "kubernetes-jwt",
                "Nested": { "bearer_token": "nested-secret", "JWKSURL": "https://issuer.example/jwks" }
            }),
            ..Default::default()
        });
        let serialized = serde_json::to_string(&method).unwrap();
        let debug = format!("{method:?}");
        assert!(!serialized.contains("top-secret"));
        assert!(!serialized.contains("nested-secret"));
        assert!(!serialized.contains("kubernetes-jwt"));
        assert!(serialized.contains("public-client"));
        assert!(!debug.contains("public-client"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn auth_method_update_preserves_omitted_sensitive_config() {
        let existing = serde_json::json!({
            "Host": "https://kubernetes.example",
            "ServiceAccountJWT": "keep-me",
            "Nested": { "OIDCClientSecret": "also-keep", "Issuer": "old" }
        });
        let mut update = serde_json::json!({
            "Host": "https://new.example",
            "Nested": { "Issuer": "new" }
        });
        merge_missing_sensitive_config(&mut update, &existing);
        assert_eq!(update["ServiceAccountJWT"], "keep-me");
        assert_eq!(update["Nested"]["OIDCClientSecret"], "also-keep");
        assert_eq!(update["Nested"]["Issuer"], "new");
    }
}
