use std::time::Duration;

use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

use crate::db::http_client_builder;
use crate::models::connection::ConnectionConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaRegistrySchemaDetail {
    pub subject: Option<String>,
    pub version: Option<i32>,
    pub schema_type: String,
    pub schema: String,
    pub schema_id: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaDecodedPayload {
    pub schema_id: Option<i32>,
    pub schema_type: Option<String>,
    pub subject: Option<String>,
    pub decoded: Option<serde_json::Value>,
    pub presentation: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SchemaRegistrySchemaResponse {
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    version: Option<i32>,
    #[serde(default, rename = "schemaType")]
    schema_type: Option<String>,
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    id: Option<i32>,
}

fn schema_registry_base_url(config: &ConnectionConfig) -> Result<String, String> {
    let url = config.kafka_schema_registry_url.trim();
    if url.is_empty() {
        return Err("Schema Registry URL is not configured for this connection".to_string());
    }
    Ok(url.trim_end_matches('/').to_string())
}

fn build_http_client(config: &ConnectionConfig) -> Result<reqwest::Client, String> {
    let timeout = Duration::from_secs(config.effective_connect_timeout_secs().max(5));
    http_client_builder(timeout).build().map_err(|e| format!("Schema Registry HTTP client error: {e}"))
}

fn apply_basic_auth(builder: reqwest::RequestBuilder, config: &ConnectionConfig) -> reqwest::RequestBuilder {
    if config.username.trim().is_empty() {
        builder
    } else {
        builder.basic_auth(config.username.trim(), Some(config.password.as_str()))
    }
}

async fn registry_get_json(config: &ConnectionConfig, path: &str) -> Result<serde_json::Value, String> {
    let base = schema_registry_base_url(config)?;
    let client = build_http_client(config)?;
    let url = format!("{base}{path}");
    let response = apply_basic_auth(client.get(&url), config)
        .send()
        .await
        .map_err(|e| format!("Schema Registry request failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("Schema Registry response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Schema Registry error ({status}): {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("Schema Registry JSON parse failed: {e}"))
}

fn parse_schema_response(value: serde_json::Value) -> Result<SchemaRegistrySchemaDetail, String> {
    let parsed: SchemaRegistrySchemaResponse =
        serde_json::from_value(value).map_err(|e| format!("Schema Registry schema response invalid: {e}"))?;
    let schema = parsed
        .schema
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Schema Registry response missing schema body".to_string())?;
    let schema_id = parsed.id.unwrap_or(-1);
    Ok(SchemaRegistrySchemaDetail {
        subject: parsed.subject,
        version: parsed.version,
        schema_type: parsed.schema_type.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "AVRO".to_string()),
        schema,
        schema_id,
    })
}

pub async fn list_subjects(config: &ConnectionConfig, prefix: Option<&str>) -> Result<Vec<String>, String> {
    let path = match prefix.filter(|value| !value.trim().is_empty()) {
        Some(prefix) => format!("/subjects?subjectPrefix={}", urlencoding_encode(prefix.trim())),
        None => "/subjects".to_string(),
    };
    let value = registry_get_json(config, &path).await?;
    let subjects = value.as_array().ok_or_else(|| "Schema Registry subjects response must be an array".to_string())?;
    let mut names = subjects.iter().filter_map(|item| item.as_str().map(str::to_string)).collect::<Vec<_>>();
    names.sort_by(|left, right| left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase()));
    Ok(names)
}

pub async fn list_subject_versions(config: &ConnectionConfig, subject: &str) -> Result<Vec<i32>, String> {
    let subject = subject.trim();
    if subject.is_empty() {
        return Err("Schema subject is required".to_string());
    }
    let path = format!("/subjects/{}/versions", urlencoding_encode(subject));
    let value = registry_get_json(config, &path).await?;
    let versions = value.as_array().ok_or_else(|| "Schema Registry versions response must be an array".to_string())?;
    let mut parsed = versions.iter().filter_map(|item| item.as_i64().map(|version| version as i32)).collect::<Vec<_>>();
    parsed.sort_unstable();
    Ok(parsed)
}

pub async fn get_schema_version(
    config: &ConnectionConfig,
    subject: &str,
    version: &str,
) -> Result<SchemaRegistrySchemaDetail, String> {
    let subject = subject.trim();
    if subject.is_empty() {
        return Err("Schema subject is required".to_string());
    }
    let version = version.trim();
    if version.is_empty() {
        return Err("Schema version is required".to_string());
    }
    let path = format!("/subjects/{}/versions/{}", urlencoding_encode(subject), urlencoding_encode(version));
    parse_schema_response(registry_get_json(config, &path).await?)
}

pub async fn get_schema_by_id(config: &ConnectionConfig, schema_id: i32) -> Result<SchemaRegistrySchemaDetail, String> {
    if schema_id < 0 {
        return Err("Schema id must be non-negative".to_string());
    }
    let path = format!("/schemas/ids/{schema_id}");
    parse_schema_response(registry_get_json(config, &path).await?)
}

pub fn decode_payload(config: &ConnectionConfig, payload: &[u8], subject_hint: Option<&str>) -> KafkaDecodedPayload {
    match decode_payload_inner(config, payload, subject_hint) {
        Ok(decoded) => decoded,
        Err(error) => KafkaDecodedPayload {
            schema_id: None,
            schema_type: None,
            subject: subject_hint.map(str::to_string),
            decoded: None,
            presentation: String::new(),
            error: Some(error),
        },
    }
}

pub async fn decode_payload_async(
    config: &ConnectionConfig,
    payload: &[u8],
    subject_hint: Option<&str>,
) -> KafkaDecodedPayload {
    match decode_payload_inner_async(config, payload, subject_hint).await {
        Ok(decoded) => decoded,
        Err(error) => KafkaDecodedPayload {
            schema_id: None,
            schema_type: None,
            subject: subject_hint.map(str::to_string),
            decoded: None,
            presentation: String::new(),
            error: Some(error),
        },
    }
}

fn decode_payload_inner(
    _config: &ConnectionConfig,
    payload: &[u8],
    subject_hint: Option<&str>,
) -> Result<KafkaDecodedPayload, String> {
    if payload.is_empty() {
        return Ok(empty_decoded(subject_hint, "Empty payload"));
    }

    if payload[0] == 0 && payload.len() >= 5 {
        let schema_id = i32::from_be_bytes(payload[1..5].try_into().map_err(|_| "Invalid schema id bytes")?);
        let body = &payload[5..];
        return Err(format!("Schema id {schema_id} requires async Schema Registry lookup ({} bytes)", body.len()));
    }

    decode_plain_payload(payload, subject_hint)
}

async fn decode_payload_inner_async(
    config: &ConnectionConfig,
    payload: &[u8],
    subject_hint: Option<&str>,
) -> Result<KafkaDecodedPayload, String> {
    if payload.is_empty() {
        return Ok(empty_decoded(subject_hint, "Empty payload"));
    }

    if payload[0] == 0 && payload.len() >= 5 {
        let schema_id = i32::from_be_bytes(payload[1..5].try_into().map_err(|_| "Invalid schema id bytes")?);
        let body = &payload[5..];
        let schema_detail = get_schema_by_id(config, schema_id).await?;
        return decode_with_schema_detail(&schema_detail, body, Some(schema_id), subject_hint);
    }

    decode_plain_payload(payload, subject_hint)
}

fn decode_with_schema_detail(
    schema_detail: &SchemaRegistrySchemaDetail,
    body: &[u8],
    schema_id: Option<i32>,
    subject_hint: Option<&str>,
) -> Result<KafkaDecodedPayload, String> {
    let schema_type = schema_detail.schema_type.to_ascii_uppercase();
    let decoded = match schema_type.as_str() {
        "AVRO" => decode_avro(&schema_detail.schema, body)?,
        "JSON" => decode_json_bytes(body)?,
        "PROTOBUF" => {
            let presentation =
                format!("Protobuf payload ({} bytes). Schema definition:\n{}", body.len(), schema_detail.schema);
            return Ok(KafkaDecodedPayload {
                schema_id,
                schema_type: Some(schema_detail.schema_type.clone()),
                subject: schema_detail.subject.clone().or_else(|| subject_hint.map(str::to_string)),
                decoded: Some(serde_json::json!({
                    "bytesLength": body.len(),
                    "hexPreview": hex_preview(body, 64),
                    "schema": schema_detail.schema,
                })),
                presentation,
                error: None,
            });
        }
        other => {
            return Err(format!("Unsupported Schema Registry type: {other}"));
        }
    };

    let presentation = serde_json::to_string_pretty(&decoded).unwrap_or_else(|_| decoded.to_string());
    Ok(KafkaDecodedPayload {
        schema_id: schema_id.or(Some(schema_detail.schema_id)),
        schema_type: Some(schema_detail.schema_type.clone()),
        subject: schema_detail.subject.clone().or_else(|| subject_hint.map(str::to_string)),
        decoded: Some(decoded),
        presentation,
        error: None,
    })
}

fn decode_plain_payload(payload: &[u8], subject_hint: Option<&str>) -> Result<KafkaDecodedPayload, String> {
    if let Ok(text) = std::str::from_utf8(payload) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
            let presentation = serde_json::to_string_pretty(&json).unwrap_or_else(|_| text.to_string());
            return Ok(KafkaDecodedPayload {
                schema_id: None,
                schema_type: Some("PLAIN_JSON".to_string()),
                subject: subject_hint.map(str::to_string),
                decoded: Some(json),
                presentation,
                error: None,
            });
        }
        return Ok(KafkaDecodedPayload {
            schema_id: None,
            schema_type: Some("UTF8".to_string()),
            subject: subject_hint.map(str::to_string),
            decoded: Some(serde_json::Value::String(text.to_string())),
            presentation: text.to_string(),
            error: None,
        });
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
    Ok(KafkaDecodedPayload {
        schema_id: None,
        schema_type: Some("BINARY".to_string()),
        subject: subject_hint.map(str::to_string),
        decoded: Some(serde_json::json!({
            "encoding": "base64",
            "data": encoded,
        })),
        presentation: encoded,
        error: None,
    })
}

fn decode_avro(schema_text: &str, body: &[u8]) -> Result<serde_json::Value, String> {
    let schema = apache_avro::Schema::parse_str(schema_text).map_err(|e| format!("Avro schema parse failed: {e}"))?;
    let value =
        apache_avro::from_avro_datum(&schema, &mut &body[..], None).map_err(|e| format!("Avro decode failed: {e}"))?;
    serde_json::Value::try_from(value).map_err(|e| format!("Avro JSON conversion failed: {e}"))
}

fn decode_json_bytes(body: &[u8]) -> Result<serde_json::Value, String> {
    let text = std::str::from_utf8(body).map_err(|e| format!("JSON payload is not valid UTF-8: {e}"))?;
    serde_json::from_str(text).map_err(|e| format!("JSON payload parse failed: {e}"))
}

fn empty_decoded(subject_hint: Option<&str>, presentation: &str) -> KafkaDecodedPayload {
    KafkaDecodedPayload {
        schema_id: None,
        schema_type: None,
        subject: subject_hint.map(str::to_string),
        decoded: None,
        presentation: presentation.to_string(),
        error: None,
    }
}

fn hex_preview(bytes: &[u8], max: usize) -> String {
    let slice = &bytes[..bytes.len().min(max)];
    let mut out = String::with_capacity(slice.len() * 2);
    for byte in slice {
        out.push_str(&format!("{byte:02x}"));
    }
    if bytes.len() > max {
        out.push_str("…");
    }
    out
}

fn urlencoding_encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ConnectionConfig, DatabaseType};

    fn kafka_config_with_registry() -> ConnectionConfig {
        ConnectionConfig {
            kafka_schema_registry_url: "http://localhost:8081".to_string(),
            db_type: DatabaseType::Kafka,
            ..test_kafka_config()
        }
    }

    fn test_kafka_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "id".to_string(),
            name: "kafka".to_string(),
            db_type: DatabaseType::Kafka,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 9092,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 300,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            etcd_endpoints: String::new(),
            kafka_bootstrap_servers: "127.0.0.1:9092".to_string(),
            kafka_security_protocol: None,
            kafka_sasl_mechanism: None,
            kafka_consumer_group: "dbx-preview".to_string(),
            kafka_schema_registry_url: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        }
    }

    #[test]
    fn decode_plain_json_without_registry_header() {
        let config = kafka_config_with_registry();
        let decoded = decode_payload(&config, br#"{"hello":"world"}"#, Some("orders-value"));
        assert_eq!(decoded.schema_type.as_deref(), Some("PLAIN_JSON"));
        assert!(decoded.error.is_none());
        assert_eq!(decoded.decoded.as_ref().and_then(|v| v.get("hello")).and_then(|v| v.as_str()), Some("world"));
    }

    #[test]
    fn decode_utf8_text_payload() {
        let config = kafka_config_with_registry();
        let decoded = decode_payload(&config, b"hello kafka", None);
        assert_eq!(decoded.schema_type.as_deref(), Some("UTF8"));
        assert_eq!(decoded.presentation, "hello kafka");
    }

    #[test]
    fn confluent_wire_format_requires_async_lookup() {
        let config = kafka_config_with_registry();
        let mut payload = vec![0, 0, 0, 0, 1, 0x02, 0x04];
        let result = decode_payload(&config, &payload, None);
        assert!(result.error.is_some());
        payload[4] = 9;
        let result = decode_payload(&config, &payload, None);
        assert!(result.error.unwrap().contains("Schema id 9"));
    }
}
