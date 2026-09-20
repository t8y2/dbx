use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};

use crate::agent_kv::{KvInt64, KvValue, KvValueEncoding};
use crate::connection::AppState;

use super::client::{client_for_state, ensure_writable_core, ConsulClient};
use super::response::{decode_json_response, ensure_success};

pub const MAX_TXN_OPERATIONS: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConsulTxnVerb {
    Get,
    GetTree,
    Set,
    Cas,
    Delete,
    DeleteCas,
    DeleteTree,
    Lock,
    Unlock,
    CheckIndex,
    CheckNotExists,
    CheckSession,
}

impl ConsulTxnVerb {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::GetTree => "get-tree",
            Self::Set => "set",
            Self::Cas => "cas",
            Self::Delete => "delete",
            Self::DeleteCas => "delete-cas",
            Self::DeleteTree => "delete-tree",
            Self::Lock => "lock",
            Self::Unlock => "unlock",
            Self::CheckIndex => "check-index",
            Self::CheckNotExists => "check-not-exists",
            Self::CheckSession => "check-session",
        }
    }

    fn writes(self) -> bool {
        matches!(
            self,
            Self::Set | Self::Cas | Self::Delete | Self::DeleteCas | Self::DeleteTree | Self::Lock | Self::Unlock
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTxnKvOperation {
    pub verb: ConsulTxnVerb,
    pub key: String,
    pub value: Option<KvValue>,
    pub flags: Option<KvInt64>,
    pub index: Option<KvInt64>,
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTxnRequest {
    pub operations: Vec<ConsulTxnKvOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTxnError {
    pub op_index: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTxnResult {
    pub committed: bool,
    pub errors: Vec<ConsulTxnError>,
    pub results: Vec<ConsulTxnKvResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsulTxnKvResult {
    pub key: String,
    pub value: Option<KvValue>,
    pub flags: KvInt64,
    pub create_index: KvInt64,
    pub modify_index: KvInt64,
    pub lock_index: KvInt64,
    pub session: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTxnResponse {
    #[serde(default)]
    errors: Option<Vec<RawTxnError>>,
    #[serde(default)]
    results: Option<Vec<RawTxnResult>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTxnResult {
    #[serde(rename = "KV", alias = "Kv")]
    kv: Option<RawTxnKvResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTxnKvResult {
    #[serde(default)]
    key: String,
    value: Option<String>,
    #[serde(default)]
    flags: u64,
    #[serde(default)]
    create_index: u64,
    #[serde(default)]
    modify_index: u64,
    #[serde(default)]
    lock_index: u64,
    session: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTxnError {
    op_index: usize,
    what: String,
}

impl ConsulClient {
    pub(super) async fn txn(&self, request: ConsulTxnRequest) -> Result<ConsulTxnResult, String> {
        validate_operations(&request.operations)?;
        let body = serde_json::to_vec(&request.operations.iter().map(operation_json).collect::<Result<Vec<_>, _>>()?)
            .map_err(|error| format!("Failed to encode Consul transaction: {error}"))?;
        let mut url = self.api_url("/v1/txn")?;
        self.append_scope(&mut url, false);
        let response = self.send(Method::PUT, url, Some(body)).await?;
        let status = response.status();
        let response = if is_txn_result_status(response.status()) {
            response
        } else {
            ensure_success(response, "execute transaction", self.token()).await?
        };
        let response = decode_json_response::<RawTxnResponse>(response, "execute transaction").await?;
        map_txn_response(status, response)
    }
}

fn map_txn_response(status: StatusCode, response: RawTxnResponse) -> Result<ConsulTxnResult, String> {
    let errors = response
        .errors
        .unwrap_or_default()
        .into_iter()
        .map(|error| ConsulTxnError { op_index: error.op_index, message: error.what })
        .collect::<Vec<_>>();
    let results = response
        .results
        .unwrap_or_default()
        .into_iter()
        .filter_map(|result| result.kv)
        .map(txn_result)
        .collect::<Result<_, _>>()?;
    Ok(ConsulTxnResult { committed: status.is_success() && errors.is_empty(), errors, results })
}

fn is_txn_result_status(status: StatusCode) -> bool {
    status.is_success() || status == StatusCode::CONFLICT
}

pub async fn consul_txn_core(
    state: &AppState,
    connection_id: &str,
    request: ConsulTxnRequest,
) -> Result<ConsulTxnResult, String> {
    validate_public_operations(&request.operations)?;
    if request.operations.iter().any(|operation| operation.verb.writes()) {
        ensure_writable_core(state, connection_id, "execute Consul transaction").await?;
    }
    let client = client_for_state(state, connection_id).await?;
    for operation in request
        .operations
        .iter()
        .filter(|operation| matches!(operation.verb, ConsulTxnVerb::Cas | ConsulTxnVerb::DeleteCas))
    {
        let current = client.get_key(&operation.key).await?;
        if current
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.session.as_deref())
            .is_some_and(|session| !session.is_empty())
        {
            return Err(format!("CONSUL_KEY_LOCKED: The Consul KV key '{}' is held by a Session", operation.key));
        }
    }
    client.txn(request).await
}

pub async fn consul_rename_key_core(
    state: &AppState,
    connection_id: &str,
    source: &str,
    target: &str,
    expected_modify_index: KvInt64,
    copy: bool,
) -> Result<ConsulTxnResult, String> {
    ensure_writable_core(state, connection_id, if copy { "copy Consul KV key" } else { "rename Consul KV key" })
        .await?;
    if source.is_empty() || target.is_empty() || source == target {
        return Err("CONSUL_RENAME_INVALID: Source and target keys must be distinct and non-empty".to_string());
    }
    let expected = parse_index(&expected_modify_index)?;
    let client = client_for_state(state, connection_id).await?;
    let current = client.get_key(source).await?;
    if !current.found {
        return Err("CONSUL_KEY_NOT_FOUND: Source key no longer exists".to_string());
    }
    let current_index = current
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.mod_revision.as_ref())
        .ok_or("CONSUL_CAS_REQUIRED: Source key has no ModifyIndex")?;
    if parse_index(current_index)? != expected {
        return Err("CONSUL_CAS_CONFLICT: Source key changed before the transaction".to_string());
    }
    if current.metadata.as_ref().and_then(|metadata| metadata.session.as_deref()).is_some_and(|value| !value.is_empty())
    {
        return Err("CONSUL_KEY_LOCKED: Source key is held by a Consul Session".to_string());
    }
    let mut operations = vec![
        ConsulTxnKvOperation {
            verb: ConsulTxnVerb::CheckIndex,
            key: source.to_string(),
            value: None,
            flags: None,
            index: Some(expected_modify_index.clone()),
            session: None,
        },
        operation(ConsulTxnVerb::CheckNotExists, target),
        ConsulTxnKvOperation {
            verb: ConsulTxnVerb::Cas,
            key: target.to_string(),
            value: current.value,
            flags: current.metadata.as_ref().and_then(|metadata| metadata.flags.clone()),
            index: Some(KvInt64("0".to_string())),
            session: None,
        },
    ];
    if !copy {
        operations.push(ConsulTxnKvOperation {
            verb: ConsulTxnVerb::DeleteCas,
            key: source.to_string(),
            value: None,
            flags: None,
            index: Some(expected_modify_index),
            session: None,
        });
    }
    client.txn(ConsulTxnRequest { operations }).await
}

pub(crate) fn cas_operation(key: String, value: KvValue, flags: KvInt64, index: KvInt64) -> ConsulTxnKvOperation {
    ConsulTxnKvOperation {
        verb: ConsulTxnVerb::Cas,
        key,
        value: Some(value),
        flags: Some(flags),
        index: Some(index),
        session: None,
    }
}

pub(crate) fn delete_cas_operation(key: String, index: KvInt64) -> ConsulTxnKvOperation {
    ConsulTxnKvOperation {
        verb: ConsulTxnVerb::DeleteCas,
        key,
        value: None,
        flags: None,
        index: Some(index),
        session: None,
    }
}

fn operation(verb: ConsulTxnVerb, key: &str) -> ConsulTxnKvOperation {
    ConsulTxnKvOperation { verb, key: key.to_string(), value: None, flags: None, index: None, session: None }
}

fn validate_operations(operations: &[ConsulTxnKvOperation]) -> Result<(), String> {
    if operations.is_empty() {
        return Err("CONSUL_TXN_EMPTY: A transaction requires at least one operation".to_string());
    }
    if operations.len() > MAX_TXN_OPERATIONS {
        return Err(format!(
            "CONSUL_TXN_LIMIT_EXCEEDED: Consul transactions support at most {MAX_TXN_OPERATIONS} operations"
        ));
    }
    for operation in operations {
        if operation.key.is_empty() {
            return Err("CONSUL_TXN_KEY_REQUIRED: Transaction keys cannot be empty".to_string());
        }
        if operation.index.as_ref().is_some_and(|index| parse_index(index).is_err()) {
            return Err(format!("CONSUL_TXN_INDEX_INVALID: Invalid Index for key {}", operation.key));
        }
        if operation.flags.as_ref().is_some_and(|flags| parse_index(flags).is_err()) {
            return Err(format!("CONSUL_TXN_FLAGS_INVALID: Invalid Flags for key {}", operation.key));
        }
        if matches!(operation.verb, ConsulTxnVerb::Lock | ConsulTxnVerb::Unlock | ConsulTxnVerb::CheckSession)
            && operation.session.as_deref().map(str::trim).is_none_or(str::is_empty)
        {
            return Err(format!(
                "CONSUL_TXN_SESSION_REQUIRED: {:?} requires a Session for key {}",
                operation.verb, operation.key
            ));
        }
        if matches!(operation.verb, ConsulTxnVerb::Lock) && operation.value.is_none() {
            return Err(format!("CONSUL_TXN_VALUE_REQUIRED: lock requires a value for key {}", operation.key));
        }
    }
    Ok(())
}

fn validate_public_operations(operations: &[ConsulTxnKvOperation]) -> Result<(), String> {
    validate_operations(operations)?;
    for operation in operations {
        match operation.verb {
            ConsulTxnVerb::Set | ConsulTxnVerb::Delete | ConsulTxnVerb::DeleteTree => {
                return Err(format!(
                    "CONSUL_TXN_UNSAFE_VERB: Public transactions cannot use unconditional {:?}; use CAS or a dedicated prefix workflow",
                    operation.verb
                ));
            }
            ConsulTxnVerb::Cas | ConsulTxnVerb::DeleteCas if operation.index.is_none() => {
                return Err(format!(
                    "CONSUL_CAS_REQUIRED: {:?} requires an Index for key {}",
                    operation.verb, operation.key
                ));
            }
            ConsulTxnVerb::Cas if operation.value.is_none() => {
                return Err(format!("CONSUL_TXN_VALUE_REQUIRED: cas requires a value for key {}", operation.key));
            }
            _ => {}
        }
    }
    Ok(())
}

fn txn_result(raw: RawTxnKvResult) -> Result<ConsulTxnKvResult, String> {
    let value = raw
        .value
        .as_deref()
        .map(|encoded| {
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|error| format!("CONSUL_INVALID_RESPONSE: Invalid transaction Value: {error}"))?;
            Ok::<_, String>(match String::from_utf8(bytes.clone()) {
                Ok(value) => KvValue { encoding: KvValueEncoding::Utf8, data: value },
                Err(_) => KvValue { encoding: KvValueEncoding::Base64, data: STANDARD.encode(bytes) },
            })
        })
        .transpose()?;
    Ok(ConsulTxnKvResult {
        key: raw.key,
        value,
        flags: KvInt64(raw.flags.to_string()),
        create_index: KvInt64(raw.create_index.to_string()),
        modify_index: KvInt64(raw.modify_index.to_string()),
        lock_index: KvInt64(raw.lock_index.to_string()),
        session: raw.session.filter(|session| !session.is_empty()),
    })
}

fn operation_json(operation: &ConsulTxnKvOperation) -> Result<serde_json::Value, String> {
    let mut kv = serde_json::Map::new();
    kv.insert("Verb".to_string(), operation.verb.as_str().into());
    kv.insert("Key".to_string(), operation.key.clone().into());
    if let Some(value) = &operation.value {
        let bytes = match value.encoding {
            KvValueEncoding::Utf8 => value.data.as_bytes().to_vec(),
            KvValueEncoding::Base64 => STANDARD
                .decode(value.data.chars().filter(|character| !character.is_whitespace()).collect::<String>())
                .map_err(|error| format!("CONSUL_VALUE_ENCODING_INVALID: {error}"))?,
        };
        kv.insert("Value".to_string(), STANDARD.encode(bytes).into());
    }
    if let Some(flags) = &operation.flags {
        kv.insert("Flags".to_string(), parse_index(flags)?.into());
    }
    if let Some(index) = &operation.index {
        kv.insert("Index".to_string(), parse_index(index)?.into());
    }
    if let Some(session) = &operation.session {
        kv.insert("Session".to_string(), session.clone().into());
    }
    Ok(serde_json::json!({ "KV": kv }))
}

fn parse_index(value: &KvInt64) -> Result<u64, String> {
    value.as_str().parse::<u64>().map_err(|_| format!("Invalid unsigned 64-bit integer: {}", value.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consul::test_support::{serve_once, test_client};

    #[test]
    fn enforces_transaction_limit() {
        let operations =
            (0..65).map(|index| operation(ConsulTxnVerb::Get, &format!("key-{index}"))).collect::<Vec<_>>();
        assert!(validate_operations(&operations).unwrap_err().contains("CONSUL_TXN_LIMIT_EXCEEDED"));
    }

    #[test]
    fn serializes_u64_as_json_number_and_value_as_base64() {
        let value = KvValue { encoding: KvValueEncoding::Utf8, data: "hello".to_string() };
        let encoded = operation_json(&cas_operation(
            "a b".to_string(),
            value,
            KvInt64(u64::MAX.to_string()),
            KvInt64("0".to_string()),
        ))
        .unwrap();
        assert_eq!(encoded["KV"]["Value"], "aGVsbG8=");
        assert_eq!(encoded["KV"]["Flags"], u64::MAX);
    }

    #[test]
    fn public_transactions_reject_unconditional_writes_and_require_cas_fields() {
        for verb in [ConsulTxnVerb::Set, ConsulTxnVerb::Delete, ConsulTxnVerb::DeleteTree] {
            assert!(validate_public_operations(&[operation(verb, "key")]).unwrap_err().contains("UNSAFE_VERB"));
        }
        assert!(validate_public_operations(&[operation(ConsulTxnVerb::Cas, "key")])
            .unwrap_err()
            .contains("CAS_REQUIRED"));
        let mut cas = cas_operation(
            "key".into(),
            KvValue { encoding: KvValueEncoding::Utf8, data: "value".into() },
            KvInt64("0".into()),
            KvInt64("0".into()),
        );
        assert!(validate_public_operations(&[cas.clone()]).is_ok());
        cas.value = None;
        assert!(validate_public_operations(&[cas]).unwrap_err().contains("VALUE_REQUIRED"));
    }

    #[test]
    fn transaction_results_preserve_kv_data_and_indexes() {
        let result = txn_result(RawTxnKvResult {
            key: "binary".into(),
            value: Some("AP+A".into()),
            flags: u64::MAX,
            create_index: 2,
            modify_index: 3,
            lock_index: 4,
            session: Some("session-1".into()),
        })
        .unwrap();
        assert_eq!(result.value.unwrap().encoding, KvValueEncoding::Base64);
        assert_eq!(result.flags.as_str(), u64::MAX.to_string());
        assert_eq!(result.modify_index.as_str(), "3");
        assert_eq!(result.session.as_deref(), Some("session-1"));
    }

    #[test]
    fn transaction_conflicts_are_decoded_as_results() {
        assert!(is_txn_result_status(StatusCode::OK));
        assert!(is_txn_result_status(StatusCode::CONFLICT));
        assert!(!is_txn_result_status(StatusCode::BAD_REQUEST));
        assert!(!is_txn_result_status(StatusCode::INTERNAL_SERVER_ERROR));
    }

    #[test]
    fn empty_conflict_response_is_never_committed() {
        let result =
            map_txn_response(StatusCode::CONFLICT, RawTxnResponse { errors: Some(vec![]), results: Some(vec![]) })
                .unwrap();
        assert!(!result.committed);
        assert!(result.errors.is_empty());
        assert!(result.results.is_empty());
    }

    #[test]
    fn committed_delete_response_accepts_consul_null_collections() {
        // Consul returns this exact shape for a successful delete-cas transaction.
        let raw: RawTxnResponse = serde_json::from_str(r#"{"Results":[],"Errors":null}"#).unwrap();
        let result = map_txn_response(StatusCode::OK, raw).unwrap();
        assert!(result.committed);
        assert!(result.errors.is_empty());
        assert!(result.results.is_empty());
    }

    #[tokio::test]
    async fn conflict_response_preserves_results_errors_and_wire_contract() {
        let body = r#"{"Results":[{"KV":{"Key":"source","Value":"aGVsbG8=","Flags":7,"CreateIndex":2,"ModifyIndex":3,"LockIndex":0}}],"Errors":[{"OpIndex":1,"What":"target exists"}]}"#;
        let response = format!(
            "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (url, request_rx) = serve_once(response).await;
        let client = test_client(url).await;
        let result =
            client.txn(ConsulTxnRequest { operations: vec![operation(ConsulTxnVerb::Get, "source")] }).await.unwrap();

        assert!(!result.committed);
        assert_eq!(result.errors[0].op_index, 1);
        assert_eq!(result.results[0].key, "source");
        assert_eq!(result.results[0].value.as_ref().unwrap().data, "hello");

        let request = request_rx.await.unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("PUT /proxy/v1/txn?dc=dc1&ns=team-a&partition=partition-a HTTP/1.1"));
        assert!(headers.to_ascii_lowercase().contains("x-consul-token: fixture-token"));
        let wire: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(wire[0]["KV"]["Verb"], "get");
        assert_eq!(wire[0]["KV"]["Key"], "source");
    }
}
