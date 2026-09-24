pub mod agent_driver;
pub mod clickhouse_driver;
pub mod cloudberry;
pub mod cloudflare_d1;
pub use cloudflare_d1 as cloudflare_d1_driver;
pub mod ddl_scan;
pub mod document_result;
pub mod dolt;
pub mod doris;
pub mod duckdb_sql;
#[cfg(feature = "duckdb-sidecar")]
pub mod duckdb_worker_process;
#[cfg(feature = "duckdb-sidecar")]
pub mod duckdb_worker_protocol;
#[cfg(feature = "dynamodb")]
#[path = "dynamodb_driver.rs"]
pub mod dynamodb_driver;
#[cfg(not(feature = "dynamodb"))]
#[path = "dynamodb_driver_disabled.rs"]
pub mod dynamodb_driver;
pub mod easysearch_driver;
pub mod elasticsearch_driver;
pub mod elasticsearch_sql;
pub mod file_validator;
pub mod hbase_driver;
pub mod http_tunnel;
pub mod influxdb3_driver;
pub mod influxdb_driver;
pub mod manticoresearch;
pub mod meilisearch_driver;
pub mod mongo_driver;
pub mod mysql;
pub mod mysql_compatible;
pub mod ob_oracle;
pub mod oceanbase_mysql;
pub mod opentenbase;
pub mod postgres;
pub mod proxy_tunnel;
pub mod questdb;
pub mod redis_driver;
pub mod rqlite_driver;
pub mod salesforce_driver;
pub mod solr_driver;
pub mod sqlite;
pub mod sqlite_worker;
pub mod sqlserver;
pub mod ssh_host_key;
pub use dbx_platform::ssh_prompt;
pub mod ssh_tunnel;
pub mod starrocks;
pub use dbx_sql::tdsql_mysql;
pub mod tidb;
pub mod transport_layer_tunnel;
pub mod turso_driver;
pub mod vector_driver;
pub mod victoriametrics_driver;
pub mod wkb;

use crate::path_utils::expand_tilde;
use reqwest::ClientBuilder;
use reqwest::{Certificate, Identity};
use std::fmt;
use std::future::Future;
use std::time::Duration;

// Re-export types so that `db::QueryResult` etc. work within dbx-core
pub use crate::mysql_event_sql::MysqlEventInfo;
pub use crate::types::*;
pub use file_validator::validate_file_path;

pub const CONNECTION_TIMEOUT_SECS: u64 = 5;
pub const TCP_PROBE_TIMEOUT_SECS: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolCheckoutStage {
    Wait,
    Create,
    Recycle,
    Unknown,
}

impl PoolCheckoutStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Create => "create",
            Self::Recycle => "recycle",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolCheckoutError {
    Timeout { database: &'static str, stage: PoolCheckoutStage, timeout: Duration },
    Failed { database: &'static str, stage: PoolCheckoutStage, detail: String },
    Canceled,
}

impl PoolCheckoutError {
    pub fn stage(&self) -> Option<PoolCheckoutStage> {
        match self {
            Self::Timeout { stage, .. } | Self::Failed { stage, .. } => Some(*stage),
            Self::Canceled => None,
        }
    }

    pub fn is_pool_saturation(&self) -> bool {
        matches!(self, Self::Timeout { stage: PoolCheckoutStage::Wait, .. })
    }
}

impl fmt::Display for PoolCheckoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout { database, stage, timeout } => write!(
                formatter,
                "{database} connection pool checkout timed out [stage={}, timeout_ms={}]",
                stage.as_str(),
                timeout.as_millis()
            ),
            Self::Failed { database, stage, detail } => {
                write!(formatter, "{database} connection pool checkout failed [stage={}]: {detail}", stage.as_str())
            }
            Self::Canceled => formatter.write_str(crate::execution::QUERY_CANCELED),
        }
    }
}

pub fn connection_timeout() -> Duration {
    Duration::from_secs(CONNECTION_TIMEOUT_SECS)
}

pub fn http_client_builder(timeout: Duration) -> ClientBuilder {
    reqwest::Client::builder().connect_timeout(timeout).no_proxy()
}

/// Augments an HTTP client builder with custom TLS material for drivers that
/// need to trust a non-system CA or present a client certificate (mTLS).
///
/// * `ca_cert_path` adds an extra root certificate (PEM bundle) alongside the
///   system roots, so self-signed server certificates are trusted.
/// * `client_cert_path` + `client_key_path` (required together) are concatenated
///   into a single PEM identity, as expected by reqwest's rustls backend.
///
/// Returns the augmented builder, or a descriptive error if a configured
/// certificate/key file cannot be read or parsed. Callers surface that error
/// instead of silently falling back to the system trust store, so a typo in a
/// cert path fails the connection loudly rather than being ignored.
pub fn apply_tls_certificates(
    mut builder: ClientBuilder,
    ca_cert_path: Option<&str>,
    client_cert_path: Option<&str>,
    client_key_path: Option<&str>,
) -> Result<ClientBuilder, String> {
    // The desktop build unifies reqwest with both `default-tls` and `rustls-tls`,
    // and `TlsBackend` defaults to native-tls there, which rejects the PEM identity
    // below with `incompatible TLS identity type`. Pin rustls like the Consul and
    // etcd-metrics clients so custom CA roots and PEM client identities work in
    // every target.
    builder = builder.use_rustls_tls();
    if let Some(ca) = ca_cert_path.filter(|path| !path.is_empty()) {
        let ca = expand_tilde(ca);
        let contents = std::fs::read(&ca)
            .map_err(|error| format!("Failed to read Elasticsearch CA certificate at {ca}: {error}"))?;
        let certificates = Certificate::from_pem_bundle(&contents)
            .map_err(|error| format!("Failed to parse Elasticsearch CA certificate at {ca}: {error}"))?;
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    if let (Some(cert_path), Some(key_path)) =
        (client_cert_path.filter(|path| !path.is_empty()), client_key_path.filter(|path| !path.is_empty()))
    {
        let cert_path = expand_tilde(cert_path);
        let key_path = expand_tilde(key_path);
        let mut pem = std::fs::read(&cert_path)
            .map_err(|error| format!("Failed to read Elasticsearch client certificate at {cert_path}: {error}"))?;
        // reqwest's rustls backend concatenates the cert and key as two PEM
        // blocks; ensure they are newline-separated so parsing succeeds even
        // when the cert file does not end with a trailing newline.
        if !pem.ends_with(b"\n") {
            pem.push(b'\n');
        }
        pem.extend(
            std::fs::read(&key_path)
                .map_err(|error| format!("Failed to read Elasticsearch client key at {key_path}: {error}"))?,
        );
        let identity = Identity::from_pem(&pem)
            .map_err(|error| format!("Failed to parse Elasticsearch client identity: {error}"))?;
        builder = builder.identity(identity);
    }
    Ok(builder)
}

pub use dbx_types::json::JS_MAX_SAFE_INTEGER;
pub use dbx_types::json::{json_value_for_js, safe_i64_to_json, safe_u64_to_json};

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn binary_value_to_json(bytes: &[u8]) -> serde_json::Value {
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

#[cfg(test)]
mod tls_tests {
    use super::{apply_tls_certificates, http_client_builder};
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    /// Generates a throwaway CA + client certificate/key (PEM) via openssl and
    /// returns their paths. If openssl is unavailable the files stay empty, which
    /// makes `apply_tls_certificates` surface a read error instead of degrading.
    fn gen_certs(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let ca_key = dir.join("ca.key");
        let ca_pem = dir.join("ca.pem");
        let csr = dir.join("client.csr");
        let client_key = dir.join("client.key");
        let client_crt = dir.join("client.crt");
        // Extensions force an X.509 v3 client cert; some toolchains (e.g.
        // OpenSSL 3.0 on CI) emit v1 without one, which rustls rejects.
        let client_ext = dir.join("client.ext");
        let _ = std::fs::write(&client_ext, "basicConstraints=critical,CA:FALSE\n");
        let _ = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                ca_key.to_str().unwrap(),
                "-out",
                ca_pem.to_str().unwrap(),
                "-days",
                "1",
                "-subj",
                "/CN=dbx-test-ca",
            ])
            .output();
        let _ = Command::new("openssl")
            .args([
                "req",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                client_key.to_str().unwrap(),
                "-out",
                csr.to_str().unwrap(),
                "-subj",
                "/CN=dbx-test-client",
            ])
            .output();
        let _ = Command::new("openssl")
            .args([
                "x509",
                "-req",
                "-in",
                csr.to_str().unwrap(),
                "-CA",
                ca_pem.to_str().unwrap(),
                "-CAkey",
                ca_key.to_str().unwrap(),
                "-CAcreateserial",
                "-out",
                client_crt.to_str().unwrap(),
                "-days",
                "1",
                "-extfile",
                client_ext.to_str().unwrap(),
            ])
            .output();
        (ca_pem, client_crt, client_key)
    }

    #[test]
    fn apply_tls_certificates_builds_with_ca_and_client_cert() {
        let dir = std::env::temp_dir().join(format!("dbx-tls-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (ca, client_crt, client_key) = gen_certs(&dir);

        let built = apply_tls_certificates(
            http_client_builder(Duration::from_secs(5)),
            ca.to_str(),
            client_crt.to_str(),
            client_key.to_str(),
        )
        .expect("client should build with CA + client cert")
        .build();
        assert!(built.is_ok(), "built client should be usable with CA + client cert: {:?}", built.err());

        // A misconfigured CA path must now surface a descriptive error instead of
        // silently degrading to the system trust store.
        let missing = apply_tls_certificates(
            http_client_builder(Duration::from_secs(5)),
            Some("/nonexistent/ca.pem"),
            None,
            None,
        );
        assert!(missing.is_err(), "missing CA path must surface a read error");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
