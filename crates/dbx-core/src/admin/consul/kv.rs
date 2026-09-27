use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

use crate::agent_kv::{
    KvDeleteOptions, KvDeleteResponse, KvGetResponse, KvInt64, KvKeyMetadata, KvKeySummary, KvListPrefixResponse,
    KvPutOptions, KvPutResponse, KvValue, KvValueEncoding, KvWriteMode,
};
use crate::connection::AppState;

use super::client::{client_for_state, ensure_writable_core, ConsulClient};
use super::response::{
    decode_json_body, decode_json_response, decode_text_response, ensure_success, is_consul_kv_not_found,
    ConsulResponseMetadata, MAX_RESPONSE_BYTES,
};
use super::types::ConsulKvEntry;

const MAX_VALUE_BYTES: usize = 512 * 1024;
pub const MAX_RECURSIVE_ENTRIES: usize = 10_000;
pub const MAX_RECURSIVE_VALUE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RECURSIVE_RESPONSE_BYTES: usize = MAX_RESPONSE_BYTES;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulKvRecord {
    pub key: String,
    pub value: KvValue,
    pub flags: KvInt64,
    pub create_index: KvInt64,
    pub modify_index: KvInt64,
    pub lock_index: KvInt64,
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulRecursiveListResponse {
    pub entries: Vec<ConsulKvRecord>,
    pub index: Option<KvInt64>,
    pub filtered_by_acls: Option<bool>,
    pub total_value_bytes: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulLockRequest {
    pub key: String,
    pub session: String,
    pub value: KvValue,
    pub flags: Option<KvInt64>,
    pub expected_modify_index: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulLockResponse {
    pub acquired: bool,
    pub key: String,
    pub session: String,
}

impl ConsulClient {
    pub(super) async fn acquire_lock(&self, request: ConsulLockRequest) -> Result<ConsulLockResponse, String> {
        let session = required_lock_field(&request.session, "session")?;
        let bytes = value_bytes(&request.value)?;
        if bytes.len() > MAX_VALUE_BYTES {
            return Err(format!("CONSUL_VALUE_TOO_LARGE: Consul KV values cannot exceed {MAX_VALUE_BYTES} bytes"));
        }
        let current = match self.get_required_entry(&request.key).await {
            Ok(current) => Some(current),
            Err(error) if error.starts_with("CONSUL_KEY_NOT_FOUND:") => None,
            Err(error) => return Err(error),
        };
        if let Some(current) = &current {
            if let Some(owner) = current.session.as_deref().filter(|owner| !owner.is_empty()) {
                if owner != session {
                    return Err("CONSUL_LOCK_CONFLICT: The key is held by a different Consul Session".to_string());
                }
            }
            let expected = request
                .expected_modify_index
                .as_ref()
                .ok_or("CONSUL_CAS_REQUIRED: Acquiring an existing Consul lock requires its ModifyIndex")?;
            if parse_u64(expected)? != current.modify_index {
                return Err("CONSUL_CAS_CONFLICT: The Consul KV key changed before lock acquisition".to_string());
            }
        } else if request.expected_modify_index.as_ref().is_some_and(|value| value.as_str() != "0") {
            return Err("CONSUL_CAS_CONFLICT: The Consul KV key no longer exists".to_string());
        }

        let cas = current.as_ref().map(|entry| entry.modify_index).unwrap_or(0);
        let flags = request
            .flags
            .as_ref()
            .map(parse_u64)
            .transpose()?
            .unwrap_or_else(|| current.as_ref().map(|entry| entry.flags).unwrap_or(0));
        let mut url = self.kv_url(&request.key)?;
        self.append_scope(&mut url, false);
        url.query_pairs_mut()
            .append_pair("acquire", session)
            .append_pair("cas", &cas.to_string())
            .append_pair("flags", &flags.to_string());
        let response =
            ensure_success(self.send(Method::PUT, url, Some(bytes)).await?, "acquire Consul KV lock", self.token())
                .await?;
        let acquired = decode_text_response(response, "acquire Consul KV lock").await?;
        if acquired.trim() != "true" {
            return Err("CONSUL_LOCK_CONFLICT: Consul refused lock acquisition".to_string());
        }
        Ok(ConsulLockResponse { acquired: true, key: request.key, session: session.to_string() })
    }

    pub(super) async fn release_lock(&self, key: &str, session: &str) -> Result<ConsulLockResponse, String> {
        let session = required_lock_field(session, "session")?;
        let current = self.get_required_entry(key).await?;
        if current.session.as_deref() != Some(session) {
            return Err("CONSUL_LOCK_SESSION_MISMATCH: Only the Session holding this key can release it".to_string());
        }
        let bytes = decode_consul_value(current.value.as_deref())?;
        let mut url = self.kv_url(key)?;
        self.append_scope(&mut url, false);
        url.query_pairs_mut()
            .append_pair("release", session)
            .append_pair("cas", &current.modify_index.to_string())
            .append_pair("flags", &current.flags.to_string());
        let response =
            ensure_success(self.send(Method::PUT, url, Some(bytes)).await?, "release Consul KV lock", self.token())
                .await?;
        let released = decode_text_response(response, "release Consul KV lock").await?;
        if released.trim() != "true" {
            return Err("CONSUL_LOCK_CONFLICT: Consul refused lock release".to_string());
        }
        Ok(ConsulLockResponse { acquired: false, key: key.to_string(), session: session.to_string() })
    }

    pub async fn list_recursive(
        &self,
        prefix: &str,
        max_entries: usize,
        max_value_bytes: usize,
    ) -> Result<ConsulRecursiveListResponse, String> {
        self.list_recursive_with_control(prefix, max_entries, max_value_bytes, None).await
    }

    pub(super) async fn list_recursive_with_control(
        &self,
        prefix: &str,
        max_entries: usize,
        max_value_bytes: usize,
        control: Option<&(dyn Fn(usize) -> Result<(), String> + Send + Sync)>,
    ) -> Result<ConsulRecursiveListResponse, String> {
        let max_entries = max_entries.clamp(1, MAX_RECURSIVE_ENTRIES);
        let max_value_bytes = max_value_bytes.clamp(MAX_VALUE_BYTES, MAX_RECURSIVE_VALUE_BYTES);
        let mut url = self.kv_url(prefix)?;
        self.append_scope(&mut url, true);
        url.query_pairs_mut().append_pair("recurse", "");
        let mut response = self.send(Method::GET, url, None).await?;
        let metadata = ConsulResponseMetadata::from_response(&response);
        if is_consul_kv_not_found(&response) {
            return Ok(ConsulRecursiveListResponse {
                entries: Vec::new(),
                index: metadata.index,
                filtered_by_acls: metadata.filtered_by_acls,
                total_value_bytes: 0,
                complete: true,
            });
        }
        if !response.status().is_success() {
            return ensure_success(response, "list Consul KV prefix recursively", self.token())
                .await
                .map(|_| unreachable!());
        }

        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Failed to read Consul recursive KV response: {}", error.without_url()))?
        {
            control.map(|check| check(0)).transpose()?;
            if body.len().saturating_add(chunk.len()) > MAX_RECURSIVE_RESPONSE_BYTES {
                return Err(format!(
                    "CONSUL_SCAN_LIMIT_EXCEEDED: Consul recursive KV response exceeds {} MiB",
                    MAX_RECURSIVE_RESPONSE_BYTES / 1024 / 1024
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let raw_entries = decode_json_body::<Vec<ConsulKvEntry>>(&body, "list Consul KV prefix recursively")?;
        if raw_entries.len() > max_entries {
            return Err(format!("CONSUL_SCAN_LIMIT_EXCEEDED: Consul prefix contains more than {max_entries} keys"));
        }

        let mut entries = Vec::with_capacity(raw_entries.len());
        let mut total_value_bytes = 0usize;
        for (index, entry) in raw_entries.into_iter().enumerate() {
            control.map(|check| check(index + 1)).transpose()?;
            let bytes = decode_consul_value(entry.value.as_deref())?;
            total_value_bytes = total_value_bytes.saturating_add(bytes.len());
            if total_value_bytes > max_value_bytes {
                return Err(format!(
                    "CONSUL_SCAN_LIMIT_EXCEEDED: Consul prefix values exceed {} MiB",
                    max_value_bytes / 1024 / 1024
                ));
            }
            entries.push(ConsulKvRecord {
                key: entry.key,
                value: value_from_bytes(&bytes),
                flags: KvInt64(entry.flags.to_string()),
                create_index: KvInt64(entry.create_index.to_string()),
                modify_index: KvInt64(entry.modify_index.to_string()),
                lock_index: KvInt64(entry.lock_index.to_string()),
                session: entry.session.filter(|session| !session.is_empty()),
            });
        }
        Ok(ConsulRecursiveListResponse {
            entries,
            index: metadata.index,
            filtered_by_acls: metadata.filtered_by_acls,
            total_value_bytes: total_value_bytes as u64,
            complete: true,
        })
    }

    pub async fn list_prefix(
        &self,
        prefix: &str,
        limit: usize,
        continuation: Option<&str>,
    ) -> Result<KvListPrefixResponse, String> {
        let mut url = self.kv_url(prefix)?;
        self.append_scope(&mut url, true);
        url.query_pairs_mut().append_pair("keys", "").append_pair("separator", "/");
        let response = self.send(Method::GET, url, None).await?;
        let metadata = ConsulResponseMetadata::from_response(&response);
        if is_consul_kv_not_found(&response) {
            return Ok(KvListPrefixResponse {
                keys: Vec::new(),
                continuation: None,
                revision: metadata.index,
                filtered_by_acls: metadata.filtered_by_acls,
            });
        }
        let response = ensure_success(response, "list KV keys", self.token()).await?;
        let mut keys = decode_json_response::<Vec<String>>(response, "list KV keys").await?;
        keys.sort();
        keys.dedup();
        if !prefix.is_empty() {
            keys.retain(|key| key != prefix);
        }
        let after = continuation.map(decode_continuation).transpose()?;
        if let Some(after) = after.as_deref() {
            keys.retain(|key| key.as_str() > after);
        }
        let limit = limit.clamp(1, 500);
        let has_more = keys.len() > limit;
        keys.truncate(limit);
        let next = has_more.then(|| keys.last().map(|key| encode_continuation(key))).flatten();
        Ok(KvListPrefixResponse {
            keys: keys.into_iter().map(summary_for_key).collect(),
            continuation: next,
            revision: metadata.index,
            filtered_by_acls: metadata.filtered_by_acls,
        })
    }

    pub async fn get_key(&self, key: &str) -> Result<KvGetResponse, String> {
        let mut url = self.kv_url(key)?;
        self.append_scope(&mut url, true);
        let response = self.send(Method::GET, url, None).await?;
        if is_consul_kv_not_found(&response) {
            return Ok(KvGetResponse { found: false, key: None, key_bytes: None, value: None, metadata: None });
        }
        let response = ensure_success(response, "read KV key", self.token()).await?;
        let mut entries = decode_json_response::<Vec<ConsulKvEntry>>(response, "read KV key").await?;
        let entry = entries.pop().ok_or("CONSUL_KEY_NOT_FOUND: Consul returned an empty KV response")?;
        let bytes = decode_consul_value(entry.value.as_deref())?;
        let value = value_from_bytes(&bytes);
        Ok(KvGetResponse {
            found: true,
            key: Some(entry.key.clone()),
            key_bytes: None,
            value: Some(value),
            metadata: Some(metadata_for_entry(&entry, bytes.len() as u64)),
        })
    }

    pub(super) async fn put_key(
        &self,
        key: &str,
        value: KvValue,
        options: KvPutOptions,
    ) -> Result<KvPutResponse, String> {
        let bytes = value_bytes(&value)?;
        if bytes.len() > MAX_VALUE_BYTES {
            return Err(format!(
                "CONSUL_VALUE_TOO_LARGE: Consul KV values cannot exceed {MAX_VALUE_BYTES} bytes (received {})",
                bytes.len()
            ));
        }

        let creating = matches!(options.write_mode, Some(KvWriteMode::Create))
            || options.expected_create_revision.as_ref().is_some_and(|value| value.as_str() == "0");
        let (cas, flags) = if creating {
            (0, options.flags.as_ref().map(parse_u64).transpose()?.unwrap_or(0))
        } else {
            let expected = parse_u64(options.expected_mod_revision.as_ref().ok_or_else(|| {
                "CONSUL_CAS_REQUIRED: Updating a Consul KV key requires its ModifyIndex".to_string()
            })?)?;
            let current = self.get_required_entry(key).await?;
            ensure_unlocked(&current)?;
            if current.modify_index != expected {
                return Err("CONSUL_CAS_CONFLICT: The Consul KV key changed before it could be saved".to_string());
            }
            (expected, options.flags.as_ref().map(parse_u64).transpose()?.unwrap_or(current.flags))
        };

        let mut url = self.kv_url(key)?;
        self.append_scope(&mut url, false);
        url.query_pairs_mut().append_pair("cas", &cas.to_string()).append_pair("flags", &flags.to_string());
        let response =
            ensure_success(self.send(Method::PUT, url, Some(bytes)).await?, "write KV key", self.token()).await?;
        let written = decode_text_response(response, "write KV key").await?;
        if written.trim() != "true" {
            return Err(if creating {
                "CONSUL_KEY_ALREADY_EXISTS: The Consul KV key already exists".to_string()
            } else {
                "CONSUL_CAS_CONFLICT: The Consul KV key changed before it could be saved".to_string()
            });
        }
        Ok(KvPutResponse { revision: None, key: Some(key.to_string()), created_key: creating.then(|| key.to_string()) })
    }

    pub(super) async fn delete_key(&self, key: &str, options: KvDeleteOptions) -> Result<KvDeleteResponse, String> {
        let expected =
            parse_u64(options.expected_mod_revision.as_ref().ok_or_else(|| {
                "CONSUL_CAS_REQUIRED: Deleting a Consul KV key requires its ModifyIndex".to_string()
            })?)?;
        let current = self.get_required_entry(key).await?;
        ensure_unlocked(&current)?;
        if current.modify_index != expected {
            return Err("CONSUL_CAS_CONFLICT: The Consul KV key changed before it could be deleted".to_string());
        }
        let mut url = self.kv_url(key)?;
        self.append_scope(&mut url, false);
        url.query_pairs_mut().append_pair("cas", &expected.to_string());
        let response =
            ensure_success(self.send(Method::DELETE, url, None).await?, "delete KV key", self.token()).await?;
        let deleted = decode_text_response(response, "delete KV key").await?;
        if deleted.trim() != "true" {
            return Err("CONSUL_CAS_CONFLICT: The Consul KV key changed before it could be deleted".to_string());
        }
        Ok(KvDeleteResponse { deleted: 1, revision: None })
    }

    async fn get_required_entry(&self, key: &str) -> Result<ConsulKvEntry, String> {
        let mut url = self.kv_url(key)?;
        self.append_scope(&mut url, true);
        let response = self.send(Method::GET, url, None).await?;
        if is_consul_kv_not_found(&response) {
            return Err("CONSUL_KEY_NOT_FOUND: The Consul KV key no longer exists".to_string());
        }
        let response = ensure_success(response, "read KV metadata", self.token()).await?;
        decode_json_response::<Vec<ConsulKvEntry>>(response, "read KV metadata")
            .await?
            .pop()
            .ok_or_else(|| "CONSUL_KEY_NOT_FOUND: Consul returned an empty KV response".to_string())
    }

    fn kv_url(&self, key: &str) -> Result<Url, String> {
        let encoded = key
            .split('/')
            .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/");
        self.api_url(&format!("/v1/kv/{encoded}"))
    }
}

pub async fn consul_list_prefix_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
) -> Result<KvListPrefixResponse, String> {
    client_for_state(state, connection_id).await?.list_prefix(prefix, limit, continuation).await
}

pub async fn consul_list_recursive_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    max_entries: usize,
    max_value_bytes: usize,
) -> Result<ConsulRecursiveListResponse, String> {
    client_for_state(state, connection_id).await?.list_recursive(prefix, max_entries, max_value_bytes).await
}

pub async fn consul_get_core(state: &AppState, connection_id: &str, key: &str) -> Result<KvGetResponse, String> {
    client_for_state(state, connection_id).await?.get_key(key).await
}

pub async fn consul_put_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: KvValue,
    options: KvPutOptions,
) -> Result<KvPutResponse, String> {
    ensure_writable_core(state, connection_id, "write Consul KV key").await?;
    client_for_state(state, connection_id).await?.put_key(key, value, options).await
}

pub async fn consul_delete_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    options: KvDeleteOptions,
) -> Result<KvDeleteResponse, String> {
    ensure_writable_core(state, connection_id, "delete Consul KV key").await?;
    client_for_state(state, connection_id).await?.delete_key(key, options).await
}

pub async fn consul_acquire_lock_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulLockRequest,
) -> Result<ConsulLockResponse, String> {
    ensure_writable_core(state, connection_id, "acquire Consul KV lock").await?;
    client_for_state(state, connection_id).await?.acquire_lock(request).await
}

pub async fn consul_release_lock_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    session: &str,
) -> Result<ConsulLockResponse, String> {
    ensure_writable_core(state, connection_id, "release Consul KV lock").await?;
    client_for_state(state, connection_id).await?.release_lock(key, session).await
}

fn required_lock_field<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("CONSUL_INVALID_REQUEST: {field} is required"))
    } else {
        Ok(value)
    }
}

fn summary_for_key(key: String) -> KvKeySummary {
    KvKeySummary { key, key_bytes: None, value: None, metadata: empty_metadata() }
}

fn metadata_for_entry(entry: &ConsulKvEntry, value_size: u64) -> KvKeyMetadata {
    KvKeyMetadata {
        create_revision: Some(KvInt64(entry.create_index.to_string())),
        mod_revision: Some(KvInt64(entry.modify_index.to_string())),
        version: None,
        lease: None,
        ttl: None,
        value_size: Some(value_size),
        czxid: None,
        mzxid: None,
        pzxid: None,
        ctime: None,
        mtime: None,
        cversion: None,
        aversion: None,
        ephemeral_owner: None,
        data_length: None,
        num_children: None,
        flags: Some(KvInt64(entry.flags.to_string())),
        lock_index: Some(KvInt64(entry.lock_index.to_string())),
        session: entry.session.clone().filter(|session| !session.is_empty()),
    }
}

fn empty_metadata() -> KvKeyMetadata {
    KvKeyMetadata {
        create_revision: None,
        mod_revision: None,
        version: None,
        lease: None,
        ttl: None,
        value_size: None,
        czxid: None,
        mzxid: None,
        pzxid: None,
        ctime: None,
        mtime: None,
        cversion: None,
        aversion: None,
        ephemeral_owner: None,
        data_length: None,
        num_children: None,
        flags: None,
        lock_index: None,
        session: None,
    }
}

fn decode_consul_value(value: Option<&str>) -> Result<Vec<u8>, String> {
    match value {
        Some(value) => {
            STANDARD.decode(value).map_err(|error| format!("Failed to decode Consul KV Base64 value: {error}"))
        }
        None => Ok(Vec::new()),
    }
}

fn value_from_bytes(bytes: &[u8]) -> KvValue {
    match std::str::from_utf8(bytes) {
        Ok(value) => KvValue { encoding: KvValueEncoding::Utf8, data: value.to_string() },
        Err(_) => KvValue { encoding: KvValueEncoding::Base64, data: STANDARD.encode(bytes) },
    }
}

fn value_bytes(value: &KvValue) -> Result<Vec<u8>, String> {
    match value.encoding {
        KvValueEncoding::Utf8 => Ok(value.data.as_bytes().to_vec()),
        KvValueEncoding::Base64 => STANDARD
            .decode(value.data.chars().filter(|char| !char.is_whitespace()).collect::<String>())
            .map_err(|error| format!("Invalid Base64 KV value: {error}")),
    }
}

fn parse_u64(value: &KvInt64) -> Result<u64, String> {
    value.as_str().parse::<u64>().map_err(|_| format!("Invalid Consul index: {}", value.as_str()))
}

fn ensure_unlocked(entry: &ConsulKvEntry) -> Result<(), String> {
    if let Some(session) = entry.session.as_deref().filter(|session| !session.is_empty()) {
        return Err(format!("CONSUL_KEY_LOCKED: The Consul KV key is held by session {session}"));
    }
    Ok(())
}

fn encode_continuation(key: &str) -> String {
    URL_SAFE_NO_PAD.encode(key.as_bytes())
}

fn decode_continuation(value: &str) -> Result<String, String> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| "Invalid Consul continuation token".to_string())?;
    String::from_utf8(bytes).map_err(|_| "Invalid Consul continuation token".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u64_fields_accept_the_full_unsigned_range_only() {
        assert_eq!(parse_u64(&KvInt64("0".into())).unwrap(), 0);
        assert_eq!(parse_u64(&KvInt64(u64::MAX.to_string())).unwrap(), u64::MAX);
        assert!(parse_u64(&KvInt64("-1".into())).is_err());
        assert!(parse_u64(&KvInt64("18446744073709551616".into())).is_err());
    }

    #[test]
    fn binary_values_round_trip_without_utf8_coercion() {
        let bytes = [0, 0xff, 0x80, b'a'];
        let value = value_from_bytes(&bytes);
        assert_eq!(value.encoding, KvValueEncoding::Base64);
        assert_eq!(value_bytes(&value).unwrap(), bytes);
    }
}
