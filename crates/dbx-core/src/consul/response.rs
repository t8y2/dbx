use reqwest::StatusCode;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::agent_kv::KvInt64;

const MAX_ERROR_BYTES: usize = 4096;
pub(super) const MAX_RESPONSE_BYTES: usize = 48 * 1024 * 1024;
pub(super) const MAX_COLLECTION_ITEMS: usize = 10_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulResponseMetadata {
    pub index: Option<KvInt64>,
    pub filtered_by_acls: Option<bool>,
    pub known_leader: Option<bool>,
    pub last_contact: Option<KvInt64>,
    pub query_backend: Option<String>,
}

impl ConsulResponseMetadata {
    pub fn from_response(response: &reqwest::Response) -> Self {
        Self {
            index: response
                .headers()
                .get("X-Consul-Index")
                .and_then(|value| value.to_str().ok())
                .map(|value| KvInt64(value.to_string())),
            filtered_by_acls: response
                .headers()
                .get("X-Consul-Results-Filtered-By-ACLs")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.eq_ignore_ascii_case("true")),
            known_leader: header(response, "X-Consul-KnownLeader").map(|value| value.eq_ignore_ascii_case("true")),
            last_contact: header(response, "X-Consul-LastContact").map(KvInt64),
            query_backend: header(response, "X-Consul-Query-Backend"),
        }
    }
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string)
}

pub(super) async fn ensure_success(
    response: reqwest::Response,
    action: &str,
    token: &str,
) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let code = match status {
        StatusCode::UNAUTHORIZED => "CONSUL_AUTH_REQUIRED",
        StatusCode::FORBIDDEN => "CONSUL_PERMISSION_DENIED",
        StatusCode::NOT_FOUND if is_consul_kv_not_found(&response) => "CONSUL_KEY_NOT_FOUND",
        StatusCode::NOT_FOUND => "CONSUL_REQUEST_FAILED",
        StatusCode::TOO_MANY_REQUESTS => "CONSUL_RATE_LIMITED",
        _ if status.is_server_error() => "CONSUL_SERVER_ERROR",
        _ => "CONSUL_REQUEST_FAILED",
    };
    let detail = limited_response_text(response).await;
    let detail = redact_sensitive(&detail, token);
    Err(format!("{code}: Failed to {action} ({status}): {}", detail.trim()))
}

pub(super) async fn decode_json_response<T: DeserializeOwned>(
    response: reqwest::Response,
    action: &str,
) -> Result<T, String> {
    let body = read_bounded_response(response, action).await?;
    decode_json_body(&body, action)
}

pub(super) async fn decode_text_response(response: reqwest::Response, action: &str) -> Result<String, String> {
    let body = read_bounded_response(response, action).await?;
    String::from_utf8(body)
        .map_err(|error| format!("CONSUL_INVALID_RESPONSE: Failed to decode {action} response as UTF-8: {error}"))
}

pub(super) async fn read_bounded_response(mut response: reqwest::Response, action: &str) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err(response_size_error(action));
    }
    let capacity = response.content_length().unwrap_or(0).min(MAX_RESPONSE_BYTES as u64) as usize;
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        format!("CONSUL_RESPONSE_READ_FAILED: Failed to read {action} response: {}", error.without_url())
    })? {
        append_bounded_chunk(&mut body, &chunk, MAX_RESPONSE_BYTES).map_err(|_| response_size_error(action))?;
    }
    Ok(body)
}

pub(super) fn decode_json_body<T: DeserializeOwned>(body: &[u8], action: &str) -> Result<T, String> {
    let value = serde_json::from_slice::<serde_json::Value>(body)
        .map_err(|error| format!("CONSUL_INVALID_RESPONSE: Failed to decode {action} response: {error}"))?;
    validate_collection_limits(&value, action, "$")?;
    serde_json::from_value(value)
        .map_err(|error| format!("CONSUL_INVALID_RESPONSE: Failed to decode {action} response: {error}"))
}

fn response_size_error(action: &str) -> String {
    format!(
        "CONSUL_RESPONSE_TOO_LARGE: {action} response body exceeds the {} MiB limit",
        MAX_RESPONSE_BYTES / 1024 / 1024
    )
}

fn append_bounded_chunk(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), ()> {
    if body.len().saturating_add(chunk.len()) > limit {
        return Err(());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn validate_collection_limits(value: &serde_json::Value, action: &str, path: &str) -> Result<(), String> {
    match value {
        serde_json::Value::Array(items) => {
            ensure_collection_limit(items.len(), action, path)?;
            for (index, item) in items.iter().enumerate() {
                validate_collection_limits(item, action, &format!("{path}[{index}]"))?;
            }
        }
        serde_json::Value::Object(items) => {
            ensure_collection_limit(items.len(), action, path)?;
            for (key, item) in items {
                validate_collection_limits(item, action, &format!("{path}.{}", json_path_key(key)))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn ensure_collection_limit(length: usize, action: &str, path: &str) -> Result<(), String> {
    if length > MAX_COLLECTION_ITEMS {
        return Err(format!(
            "CONSUL_RESPONSE_ITEM_LIMIT_EXCEEDED: {action} response collection at {path} contains {length} items; maximum is {MAX_COLLECTION_ITEMS}"
        ));
    }
    Ok(())
}

fn json_path_key(key: &str) -> String {
    if key.chars().all(|character| character.is_ascii_alphanumeric() || character == '_') {
        key.to_string()
    } else {
        format!("[{key:?}]")
    }
}

pub(crate) fn redact_sensitive(detail: &str, token: &str) -> String {
    let mut redacted = if token.is_empty() { detail.to_string() } else { detail.replace(token, "[REDACTED]") };
    for marker in [
        "SecretID",
        "Secret_ID",
        "Secret-ID",
        "Secret",
        "JWT",
        "BootstrapToken",
        "Bootstrap_Token",
        "Bootstrap-Token",
        "PeeringToken",
        "Peering_Token",
        "Peering-Token",
        "X-Consul-Token",
        "X_Consul_Token",
    ] {
        redacted = redact_jsonish_field(&redacted, marker);
    }
    redacted
}

fn redact_jsonish_field(value: &str, marker: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    let marker = marker.to_ascii_lowercase();
    while let Some(index) = rest.to_ascii_lowercase().find(&marker) {
        let (before, after_marker) = rest.split_at(index + marker.len());
        output.push_str(before);
        let Some(separator) = after_marker.find([':', '=']) else {
            rest = after_marker;
            continue;
        };
        output.push_str(&after_marker[..=separator]);
        let after_separator = &after_marker[separator + 1..];
        let leading = after_separator.len() - after_separator.trim_start().len();
        output.push_str(&after_separator[..leading]);
        output.push_str("[REDACTED]");
        let value_start = &after_separator[leading..];
        let end = value_start.find([',', '}', '\n', '\r', '&']).unwrap_or(value_start.len());
        rest = &value_start[end..];
    }
    output.push_str(rest);
    output
}

pub(super) fn is_consul_kv_not_found(response: &reqwest::Response) -> bool {
    response.status() == StatusCode::NOT_FOUND && ConsulResponseMetadata::from_response(response).index.is_some()
}

async fn limited_response_text(mut response: reqwest::Response) -> String {
    let mut body = Vec::with_capacity(MAX_ERROR_BYTES);
    while body.len() < MAX_ERROR_BYTES {
        let Ok(Some(chunk)) = response.chunk().await else {
            break;
        };
        if append_limited_error_chunk(&mut body, &chunk) {
            break;
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

fn append_limited_error_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let remaining = MAX_ERROR_BYTES.saturating_sub(body.len());
    body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    chunk.len() >= remaining
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_acl_and_peering_secrets() {
        let detail = r#"{"SecretID":"acl-secret","peering_token":"peer-secret","bootstrap-token":"bootstrap-secret","nested":{"oidcClientSecret":"oidc-secret"},"message":"bad"}"#;
        let redacted = redact_sensitive(detail, "connection-token");
        assert!(!redacted.contains("acl-secret"));
        assert!(!redacted.contains("peer-secret"));
        assert!(!redacted.contains("bootstrap-secret"));
        assert!(!redacted.contains("oidc-secret"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn limits_error_body_to_four_kibibytes_across_chunks() {
        let mut body = Vec::new();
        assert!(!append_limited_error_chunk(&mut body, &[b'a'; 3_000]));
        assert!(append_limited_error_chunk(&mut body, &[b'b'; 3_000]));
        assert_eq!(body.len(), MAX_ERROR_BYTES);
        assert_eq!(&body[..3_000], &[b'a'; 3_000]);
        assert!(body[3_000..].iter().all(|byte| *byte == b'b'));
    }

    #[test]
    fn bounded_chunk_accepts_exact_limit_and_rejects_next_byte() {
        let mut body = Vec::new();
        assert_eq!(append_bounded_chunk(&mut body, b"1234", 4), Ok(()));
        assert_eq!(body, b"1234");
        assert_eq!(append_bounded_chunk(&mut body, b"5", 4), Err(()));
        assert_eq!(body, b"1234");
    }

    #[test]
    fn json_collection_limit_accepts_boundary() {
        let body = serde_json::to_vec(&vec![0_u8; MAX_COLLECTION_ITEMS]).unwrap();
        let decoded = decode_json_body::<Vec<u8>>(&body, "test list").unwrap();
        assert_eq!(decoded.len(), MAX_COLLECTION_ITEMS);
    }

    #[test]
    fn json_collection_limit_reports_path_and_count() {
        let value = serde_json::json!({ "items": vec![0_u8; MAX_COLLECTION_ITEMS + 1] });
        let body = serde_json::to_vec(&value).unwrap();
        let error = decode_json_body::<serde_json::Value>(&body, "test list").unwrap_err();
        assert!(error.starts_with("CONSUL_RESPONSE_ITEM_LIMIT_EXCEEDED:"));
        assert!(error.contains("$.items"));
        assert!(error.contains("10001 items"));
    }
}
