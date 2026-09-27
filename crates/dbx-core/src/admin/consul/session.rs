use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};

use crate::connection::AppState;

use super::catalog::{encode_segment, ConsulListResponse, ConsulReadOptions};
use super::client::{client_for_state, ensure_writable_core, ConsulClient};
use super::kv::ConsulKvRecord;
use super::response::{decode_json_response, decode_text_response, ensure_success};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulSession {
    #[serde(default, rename = "ID", alias = "Id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub lock_delay: u64,
    #[serde(default)]
    pub behavior: String,
    #[serde(default, rename = "TTL", alias = "Ttl")]
    pub ttl: String,
    #[serde(default, rename = "NodeChecks", alias = "Checks", deserialize_with = "deserialize_null_default")]
    pub node_checks: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub service_checks: Vec<ConsulSessionServiceCheck>,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub partition: String,
    #[serde(default)]
    pub create_index: u64,
    #[serde(default)]
    pub modify_index: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ConsulSessionServiceCheck {
    #[serde(default, rename = "ID", alias = "Id")]
    pub id: String,
    #[serde(default)]
    pub namespace: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionCreateRequest {
    pub name: String,
    pub node: String,
    pub lock_delay: Option<String>,
    pub behavior: String,
    pub ttl: Option<String>,
    #[serde(default, alias = "checks")]
    pub node_checks: Vec<String>,
    #[serde(default)]
    pub service_checks: Vec<ConsulSessionServiceCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionHeldKey {
    pub key: String,
    pub modify_index: crate::agent_kv::KvInt64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionKeysResponse {
    pub items: Vec<ConsulKvRecord>,
    pub complete: bool,
    pub filtered_by_acls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionDestroyImpact {
    pub session: ConsulSession,
    pub held_keys: Vec<ConsulSessionHeldKey>,
    pub complete: bool,
    pub filtered_by_acls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulSessionDestroyRequest {
    pub id: String,
    pub expected_behavior: String,
    pub expected_held_keys: Vec<ConsulSessionHeldKey>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SessionCreateResponse {
    #[serde(rename = "ID", alias = "Id")]
    id: String,
}

impl ConsulClient {
    pub async fn sessions(
        &self,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulSession>>, String> {
        self.read_list("/v1/session/list", options, "list Consul sessions").await
    }

    pub async fn node_sessions(
        &self,
        node: &str,
        options: &ConsulReadOptions,
    ) -> Result<ConsulListResponse<Vec<ConsulSession>>, String> {
        self.read_list(
            &format!("/v1/session/node/{}", encode_segment(required(node, "node")?)),
            options,
            "list Consul node sessions",
        )
        .await
    }

    pub async fn session(&self, id: &str) -> Result<Option<ConsulSession>, String> {
        let mut url = self.api_url(&format!("/v1/session/info/{}", encode_segment(required(id, "session id")?)))?;
        self.append_scope(&mut url, true);
        let response =
            ensure_success(self.send(Method::GET, url, None).await?, "read Consul session", self.token()).await?;
        let mut items = decode_json_response::<Vec<ConsulSession>>(response, "read Consul session").await?;
        Ok(items.pop())
    }

    pub(super) async fn create_session(&self, request: ConsulSessionCreateRequest) -> Result<ConsulSession, String> {
        let behavior = request.behavior.trim().to_ascii_lowercase();
        if !matches!(behavior.as_str(), "release" | "delete") {
            return Err("CONSUL_INVALID_REQUEST: Session behavior must be release or delete".to_string());
        }
        let ttl = validate_session_ttl(request.ttl.as_deref())?;
        let lock_delay = validate_lock_delay(request.lock_delay.as_deref())?;
        let mut url = self.api_url("/v1/session/create")?;
        self.append_scope(&mut url, false);
        let body = serde_json::to_vec(&serde_json::json!({
            "Name": request.name,
            "Node": request.node,
            "LockDelay": lock_delay,
            "Behavior": behavior,
            "TTL": ttl,
            "NodeChecks": request.node_checks,
            "ServiceChecks": request.service_checks,
        }))
        .map_err(|error| format!("Failed to encode Consul session: {error}"))?;
        let response =
            ensure_success(self.send(Method::PUT, url, Some(body)).await?, "create Consul session", self.token())
                .await?;
        let created = decode_json_response::<SessionCreateResponse>(response, "create Consul session").await?;
        self.session(&created.id)
            .await?
            .ok_or_else(|| "CONSUL_SESSION_NOT_FOUND: Created session was not returned by Consul".to_string())
    }

    pub(super) async fn renew_session(&self, id: &str) -> Result<ConsulSession, String> {
        let mut url = self.api_url(&format!("/v1/session/renew/{}", encode_segment(required(id, "session id")?)))?;
        self.append_scope(&mut url, false);
        let response =
            ensure_success(self.send(Method::PUT, url, None).await?, "renew Consul session", self.token()).await?;
        let mut items = decode_json_response::<Vec<ConsulSession>>(response, "renew Consul session").await?;
        items.pop().ok_or_else(|| "CONSUL_SESSION_NOT_FOUND: Session no longer exists".to_string())
    }

    pub(super) async fn destroy_session(&self, id: &str) -> Result<bool, String> {
        let mut url = self.api_url(&format!("/v1/session/destroy/{}", encode_segment(required(id, "session id")?)))?;
        self.append_scope(&mut url, false);
        let response =
            ensure_success(self.send(Method::PUT, url, None).await?, "destroy Consul session", self.token()).await?;
        let result = decode_text_response(response, "destroy Consul session").await?;
        if result.trim() != "true" {
            return Err("CONSUL_SESSION_CONFLICT: Consul refused to destroy the session".to_string());
        }
        Ok(true)
    }

    pub async fn session_keys(&self, id: &str) -> Result<ConsulSessionKeysResponse, String> {
        let id = required(id, "session id")?;
        let response = self.list_recursive("", 10_000, 32 * 1024 * 1024).await?;
        let filtered_by_acls = response.filtered_by_acls == Some(true);
        Ok(ConsulSessionKeysResponse {
            items: response.entries.into_iter().filter(|entry| entry.session.as_deref() == Some(id)).collect(),
            complete: response.complete && !filtered_by_acls,
            filtered_by_acls,
        })
    }

    async fn session_destroy_impact(&self, id: &str) -> Result<ConsulSessionDestroyImpact, String> {
        let session =
            self.session(id).await?.ok_or_else(|| "CONSUL_SESSION_NOT_FOUND: Session no longer exists".to_string())?;
        let recursive = self.list_recursive("", 10_000, 32 * 1024 * 1024).await?;
        let mut held_keys = recursive
            .entries
            .into_iter()
            .filter(|entry| entry.session.as_deref() == Some(session.id.as_str()))
            .map(|entry| ConsulSessionHeldKey { key: entry.key, modify_index: entry.modify_index })
            .collect::<Vec<_>>();
        held_keys.sort_by(|left, right| left.key.cmp(&right.key));
        let filtered_by_acls = recursive.filtered_by_acls == Some(true);
        Ok(ConsulSessionDestroyImpact {
            session,
            held_keys,
            complete: recursive.complete && !filtered_by_acls,
            filtered_by_acls,
        })
    }
}

fn required<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("CONSUL_INVALID_REQUEST: {field} is required"))
    } else {
        Ok(value)
    }
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn validate_session_ttl(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = normalized_duration(value) else { return Ok(None) };
    let milliseconds = parse_consul_duration_ms(&value, "Session TTL")?;
    if !(10_000.0..=86_400_000.0).contains(&milliseconds) {
        return Err("CONSUL_INVALID_REQUEST: Session TTL must be between 10s and 24h".to_string());
    }
    Ok(Some(value))
}

fn validate_lock_delay(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = normalized_duration(value) else { return Ok(None) };
    let milliseconds = parse_consul_duration_ms(&value, "Session LockDelay")?;
    if !(0.0..=60_000.0).contains(&milliseconds) {
        return Err("CONSUL_INVALID_REQUEST: Session LockDelay must be between 0s and 60s".to_string());
    }
    Ok(Some(value))
}

fn normalized_duration(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn parse_consul_duration_ms(value: &str, field: &str) -> Result<f64, String> {
    let bytes = value.as_bytes();
    let mut offset = 0;
    let mut total = 0.0;
    while offset < bytes.len() {
        let start = offset;
        let mut dots = 0;
        while offset < bytes.len() && (bytes[offset].is_ascii_digit() || bytes[offset] == b'.') {
            if bytes[offset] == b'.' {
                dots += 1;
            }
            offset += 1;
        }
        if offset == start || dots > 1 {
            return Err(format!("CONSUL_INVALID_REQUEST: {field} must use duration units ms, s, m, or h"));
        }
        let amount = value[start..offset]
            .parse::<f64>()
            .map_err(|_| format!("CONSUL_INVALID_REQUEST: {field} is not a valid duration"))?;
        let multiplier = if value[offset..].starts_with("ms") {
            offset += 2;
            1.0
        } else if offset < bytes.len() {
            let multiplier = match bytes[offset] {
                b's' => 1_000.0,
                b'm' => 60_000.0,
                b'h' => 3_600_000.0,
                _ => return Err(format!("CONSUL_INVALID_REQUEST: {field} must use duration units ms, s, m, or h")),
            };
            offset += 1;
            multiplier
        } else {
            return Err(format!("CONSUL_INVALID_REQUEST: {field} must include a duration unit"));
        };
        total += amount * multiplier;
    }
    if !total.is_finite() {
        return Err(format!("CONSUL_INVALID_REQUEST: {field} is not a valid duration"));
    }
    Ok(total)
}

pub async fn consul_sessions_core(
    state: &AppState,
    connection_id: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulSession>>, String> {
    client_for_state(state, connection_id).await?.sessions(&options).await
}

pub async fn consul_node_sessions_core(
    state: &AppState,
    connection_id: &str,
    node: &str,
    options: ConsulReadOptions,
) -> Result<ConsulListResponse<Vec<ConsulSession>>, String> {
    client_for_state(state, connection_id).await?.node_sessions(node, &options).await
}

pub async fn consul_session_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<Option<ConsulSession>, String> {
    client_for_state(state, connection_id).await?.session(id).await
}

pub async fn consul_session_keys_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulSessionKeysResponse, String> {
    client_for_state(state, connection_id).await?.session_keys(id).await
}

pub async fn consul_session_destroy_impact_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulSessionDestroyImpact, String> {
    client_for_state(state, connection_id).await?.session_destroy_impact(id).await
}

pub async fn consul_create_session_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulSessionCreateRequest,
) -> Result<ConsulSession, String> {
    ensure_writable_core(state, connection_id, "create Consul session").await?;
    client_for_state(state, connection_id).await?.create_session(request).await
}

pub async fn consul_renew_session_core(
    state: &AppState,
    connection_id: &str,
    id: &str,
) -> Result<ConsulSession, String> {
    ensure_writable_core(state, connection_id, "renew Consul session").await?;
    client_for_state(state, connection_id).await?.renew_session(id).await
}

pub async fn consul_destroy_session_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulSessionDestroyRequest,
) -> Result<bool, String> {
    ensure_writable_core(state, connection_id, "destroy Consul session").await?;
    let client = client_for_state(state, connection_id).await?;
    let impact = client.session_destroy_impact(&request.id).await?;
    if !impact.complete {
        return Err("CONSUL_IMPACT_INCOMPLETE: Session-held keys could not be enumerated completely".to_string());
    }
    validate_destroy_confirmation(&impact, &request)?;
    client.destroy_session(&request.id).await
}

fn validate_destroy_confirmation(
    impact: &ConsulSessionDestroyImpact,
    request: &ConsulSessionDestroyRequest,
) -> Result<(), String> {
    let mut expected_keys = request.expected_held_keys.clone();
    expected_keys.sort_by(|left, right| left.key.cmp(&right.key));
    if impact.session.id != request.id
        || impact.session.behavior != request.expected_behavior
        || impact.held_keys != expected_keys
    {
        return Err("CONSUL_SESSION_CONFLICT: Session behavior or held keys changed after confirmation".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consul::test_support::{serve_once, test_client};

    #[test]
    fn decodes_consul_two_session_checks_and_indexes() {
        let session: ConsulSession = serde_json::from_str(
            r#"{
                "ID":"session-1",
                "Name":"demo",
                "Node":"node-1",
                "LockDelay":15000000000,
                "Behavior":"release",
                "TTL":"",
                "NodeChecks":["serfHealth"],
                "ServiceChecks":[{"ID":"service:api:health","Namespace":"team-a"}],
                "CreateIndex":12,
                "ModifyIndex":18
            }"#,
        )
        .unwrap();

        assert_eq!(session.id, "session-1");
        assert_eq!(session.node_checks, vec!["serfHealth"]);
        assert_eq!(session.service_checks[0].id, "service:api:health");
        assert_eq!(session.service_checks[0].namespace, "team-a");
        assert_eq!(session.modify_index, 18);

        let local_dev: ConsulSession =
            serde_json::from_str(r#"{"ID":"session-2","NodeChecks":["serfHealth"],"ServiceChecks":null}"#).unwrap();
        assert!(local_dev.service_checks.is_empty());
    }

    #[test]
    fn accepts_legacy_checks_as_node_checks() {
        let session: ConsulSession = serde_json::from_str(r#"{"ID":"legacy","Checks":["serfHealth"]}"#).unwrap();
        assert_eq!(session.node_checks, vec!["serfHealth"]);
    }

    #[test]
    fn validates_session_duration_boundaries() {
        assert_eq!(validate_session_ttl(None).unwrap(), None);
        assert_eq!(validate_session_ttl(Some("10s")).unwrap(), Some("10s".into()));
        assert_eq!(validate_session_ttl(Some("24h")).unwrap(), Some("24h".into()));
        assert!(validate_session_ttl(Some("9.999s")).is_err());
        assert!(validate_session_ttl(Some("24h1s")).is_err());
        assert_eq!(validate_lock_delay(Some("0s")).unwrap(), Some("0s".into()));
        assert_eq!(validate_lock_delay(Some("1m")).unwrap(), Some("1m".into()));
        assert!(validate_lock_delay(Some("60s1ms")).is_err());
    }

    #[tokio::test]
    async fn renew_uses_put_encoded_id_scope_and_acl_header() {
        let body = r#"[{"ID":"session/a","TTL":"30s","Behavior":"release"}]"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (url, request_rx) = serve_once(response).await;
        let client = test_client(url).await;
        let renewed = client.renew_session("session/a").await.unwrap();

        assert_eq!(renewed.id, "session/a");
        assert_eq!(renewed.ttl, "30s");
        let request = request_rx.await.unwrap();
        let headers = request.split_once("\r\n\r\n").unwrap().0;
        assert!(headers
            .starts_with("PUT /proxy/v1/session/renew/session%2Fa?dc=dc1&ns=team-a&partition=partition-a HTTP/1.1"));
        assert!(headers.to_ascii_lowercase().contains("x-consul-token: fixture-token"));
    }

    #[test]
    fn destroy_confirmation_rejects_changed_held_keys() {
        let impact = ConsulSessionDestroyImpact {
            session: ConsulSession { id: "session-1".into(), behavior: "delete".into(), ..Default::default() },
            held_keys: vec![ConsulSessionHeldKey {
                key: "locks/a".into(),
                modify_index: crate::agent_kv::KvInt64("4".into()),
            }],
            complete: true,
            filtered_by_acls: false,
        };
        let stale = ConsulSessionDestroyRequest {
            id: "session-1".into(),
            expected_behavior: "delete".into(),
            expected_held_keys: Vec::new(),
        };
        assert!(validate_destroy_confirmation(&impact, &stale).is_err());
        let current = ConsulSessionDestroyRequest {
            id: "session-1".into(),
            expected_behavior: "delete".into(),
            expected_held_keys: impact.held_keys.clone(),
        };
        assert!(validate_destroy_confirmation(&impact, &current).is_ok());
    }
}
