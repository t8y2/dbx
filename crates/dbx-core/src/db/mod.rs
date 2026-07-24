pub mod agent_driver;
pub mod clickhouse_driver;
pub mod cloudflare_d1;
pub use cloudflare_d1 as cloudflare_d1_driver;
pub mod document_result;
pub mod duckdb_driver;
pub mod duckdb_sql;
#[cfg(feature = "duckdb-bundled")]
pub mod duckdb_worker_process;
#[cfg(feature = "duckdb-bundled")]
pub mod duckdb_worker_protocol;
#[cfg(feature = "duckdb-bundled")]
pub mod duckdb_worker_runtime;
pub mod elasticsearch_driver;
pub mod elasticsearch_sql;
pub mod file_validator;
pub mod http_tunnel;
pub mod influxdb_driver;
pub mod manticoresearch;
pub mod mongo_driver;
pub mod mysql;
pub mod ob_oracle;
pub mod postgres;
pub mod proxy_tunnel;
pub mod questdb;
pub mod redis_driver;
pub mod rqlite_driver;
pub mod sqlite;
pub mod sqlserver;
pub mod ssh_tunnel;
pub mod transport_layer_tunnel;
pub mod turso_driver;
pub mod vector_driver;
pub mod wkb;

use reqwest::ClientBuilder;
use std::future::Future;
use std::time::Duration;

// Re-export types so that `db::QueryResult` etc. work within dbx-core
pub use crate::types::*;
pub use file_validator::validate_file_path;

pub const CONNECTION_TIMEOUT_SECS: u64 = 5;
pub const TCP_PROBE_TIMEOUT_SECS: u64 = 3;

pub fn connection_timeout() -> Duration {
    Duration::from_secs(CONNECTION_TIMEOUT_SECS)
}

pub fn http_client_builder(timeout: Duration) -> ClientBuilder {
    reqwest::Client::builder().connect_timeout(timeout).no_proxy()
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn safe_i64_to_json(v: i64) -> serde_json::Value {
    if !(-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&v) {
        serde_json::Value::String(v.to_string())
    } else {
        serde_json::Value::Number(v.into())
    }
}

pub fn safe_u64_to_json(v: u64) -> serde_json::Value {
    if v > JS_MAX_SAFE_INTEGER as u64 {
        serde_json::Value::String(v.to_string())
    } else {
        serde_json::Value::Number(v.into())
    }
}

pub fn json_value_for_js(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                safe_i64_to_json(value)
            } else if let Some(value) = number.as_u64() {
                safe_u64_to_json(value)
            } else {
                serde_json::Value::Number(number)
            }
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(json_value_for_js).collect())
        }
        serde_json::Value::Object(entries) => {
            serde_json::Value::Object(entries.into_iter().map(|(key, value)| (key, json_value_for_js(value))).collect())
        }
        value => value,
    }
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub(crate) fn binary_value_to_json(bytes: &[u8]) -> serde_json::Value {
    serde_json::Value::String(format!("0x{}", hex_encode(bytes)))
}

pub fn tcp_probe_timeout() -> Duration {
    Duration::from_secs(TCP_PROBE_TIMEOUT_SECS)
}

pub fn parse_connect_timeout(url: &str) -> Duration {
    parse_connect_timeout_with_fallback(url, connection_timeout())
}

pub fn parse_connect_timeout_with_fallback(url: &str, fallback: Duration) -> Duration {
    let Some(query) = url.split('?').nth(1) else {
        return fallback;
    };
    for param in query.split('&') {
        let trimmed = param.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (key, value) = match trimmed.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        if key.eq_ignore_ascii_case("connect_timeout")
            || key.eq_ignore_ascii_case("connectTimeout")
            || key.eq_ignore_ascii_case("connection_timeout")
            || key.eq_ignore_ascii_case("connectionTimeout")
        {
            if let Ok(v) = value.parse::<u64>() {
                if (1..=300).contains(&v) {
                    return Duration::from_secs(v);
                }
            }
        }
    }
    fallback
}

pub async fn with_connection_timeout<T, F>(label: &str, timeout: Duration, future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("{label} connection timed out ({}s)", timeout.as_secs()))?
}

pub async fn probe_tcp_endpoint(label: &str, host: &str, port: u16, timeout: Duration) -> Result<(), String> {
    tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("{label} TCP connection timed out ({}s)", timeout.as_secs()))?
        .map(|_| ())
        .map_err(|e| format!("{label} TCP connection failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_values_are_displayed_as_prefixed_hex() {
        assert_eq!(binary_value_to_json(&[0x00, 0x01, 0xab, 0xff]), serde_json::json!("0x0001abff"));
    }
}
