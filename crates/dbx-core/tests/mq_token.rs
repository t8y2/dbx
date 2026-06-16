#![cfg(feature = "mq-admin")]

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use dbx_core::mq::token::{sign_pulsar_token, token_fingerprint};
use dbx_core::mq::{MqTokenIssueRequest, MqTokenRecord, MqTokenSigningAlgorithm, MqTokenSigningConfig};
use dbx_core::storage::Storage;

#[test]
fn hs256_token_contains_pulsar_subject_and_expiry() {
    let config = MqTokenSigningConfig { algorithm: MqTokenSigningAlgorithm::Hs256, key: "broker-secret".to_string() };
    let req = MqTokenIssueRequest {
        subject: "order-consumer".to_string(),
        expires_in_seconds: Some(3600),
        scope: None,
        actions: vec![],
        note: None,
    };

    let issued = sign_pulsar_token(&config, &req, 1_700_000_000).unwrap();
    let payload = issued.token.split('.').nth(1).unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();

    assert_eq!(payload.get("sub").and_then(serde_json::Value::as_str), Some("order-consumer"));
    assert_eq!(payload.get("iat").and_then(serde_json::Value::as_i64), Some(1_700_000_000));
    assert_eq!(payload.get("exp").and_then(serde_json::Value::as_i64), Some(1_700_003_600));
    assert_eq!(issued.fingerprint, token_fingerprint(&issued.token));
}

#[test]
fn token_signing_requires_configured_key() {
    let config = MqTokenSigningConfig { algorithm: MqTokenSigningAlgorithm::Hs256, key: "   ".to_string() };
    let req = MqTokenIssueRequest {
        subject: "order-consumer".to_string(),
        expires_in_seconds: None,
        scope: None,
        actions: vec![],
        note: None,
    };

    let err = sign_pulsar_token(&config, &req, 1_700_000_000).unwrap_err();
    assert!(err.contains("signing key"));
}

#[tokio::test]
async fn token_records_are_saved_without_token_plaintext() {
    let storage = Storage::open(&temp_db_path("mq-token-records")).await.unwrap();
    let record = MqTokenRecord {
        id: "rec-1".to_string(),
        connection_id: "conn-1".to_string(),
        subject: "order-consumer".to_string(),
        algorithm: MqTokenSigningAlgorithm::Hs256,
        token_fingerprint: "sha256:abc".to_string(),
        scope: None,
        actions: vec![],
        expires_at: Some("2026-06-14T12:00:00Z".to_string()),
        created_at: "2026-06-14T11:00:00Z".to_string(),
        note: "issued for test".to_string(),
    };

    storage.save_mq_token_record(&record).await.unwrap();
    let records = storage.load_mq_token_records("conn-1", Some("order-consumer")).await.unwrap();

    assert_eq!(records, vec![record]);
    let json = serde_json::to_value(&records[0]).unwrap();
    assert!(json.get("token").is_none());
}

fn temp_db_path(name: &str) -> std::path::PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("dbx-{name}-{}-{stamp}.db", std::process::id()))
}
