use crate::path_utils::expand_tilde;
use reqwest::ClientBuilder;
use reqwest::{Certificate, Identity};
use std::fmt;
use std::future::Future;
use std::time::Duration;

// Re-export types so that `db::QueryResult` etc. work within dbx-core
pub use crate::file_validator::validate_file_path;
pub use crate::types::*;

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
    builder: ClientBuilder,
    ca_cert_path: Option<&str>,
    client_cert_path: Option<&str>,
    client_key_path: Option<&str>,
) -> Result<ClientBuilder, String> {
    // No SSL_CERT_FILE environment fallback here: Elasticsearch/Solr/CouchDB keep
    // their historical behavior (bundled roots only when no CA is configured).
    apply_tls_certificates_impl(builder, ca_cert_path, client_cert_path, client_key_path, "Elasticsearch", false)
}

/// Augments an HTTP client builder with custom TLS material for a specific driver.
///
/// * `ca_cert_path`: adds an extra root certificate (PEM bundle or DER). If not provided
///   or empty, falls back to `SSL_CERT_FILE` from the environment if present and pointing
///   to an existing file. This environment fallback applies ONLY to drivers that call
///   this function (Cloudflare D1, Turso), never to the `apply_tls_certificates`
///   wrapper above.
/// * `client_cert_path` + `client_key_path`: concatenated into a single PEM identity.
/// * `driver_label`: included in descriptive error messages (e.g. "Cloudflare D1", "Turso").
pub fn apply_tls_certificates_for_driver(
    builder: ClientBuilder,
    ca_cert_path: Option<&str>,
    client_cert_path: Option<&str>,
    client_key_path: Option<&str>,
    driver_label: &str,
) -> Result<ClientBuilder, String> {
    apply_tls_certificates_impl(builder, ca_cert_path, client_cert_path, client_key_path, driver_label, true)
}

fn apply_tls_certificates_impl(
    mut builder: ClientBuilder,
    ca_cert_path: Option<&str>,
    client_cert_path: Option<&str>,
    client_key_path: Option<&str>,
    driver_label: &str,
    env_ca_fallback: bool,
) -> Result<ClientBuilder, String> {
    // The desktop build unifies reqwest with both `default-tls` and `rustls-tls`,
    // and `TlsBackend` defaults to native-tls there, which rejects the PEM identity
    // below with `incompatible TLS identity type`. Pin rustls like the Consul and
    // etcd-metrics clients so custom CA roots and PEM client identities work in
    // every target.
    builder = builder.use_rustls_tls();
    let explicit_ca = ca_cert_path.map(str::trim).filter(|path| !path.is_empty()).map(ToOwned::to_owned);
    let env_ca = if env_ca_fallback {
        std::env::var("SSL_CERT_FILE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|path| !path.is_empty() && std::path::Path::new(&expand_tilde(path)).exists())
    } else {
        None
    };
    let effective_ca = explicit_ca.or(env_ca);

    if let Some(ca) = effective_ca {
        let ca = expand_tilde(&ca);
        let contents = std::fs::read(&ca)
            .map_err(|error| format!("Failed to read {driver_label} CA certificate at {ca}: {error}"))?;
        let certificates = Certificate::from_pem_bundle(&contents)
            .or_else(|_| Certificate::from_der(&contents).map(|cert| vec![cert]))
            .map_err(|error| format!("Failed to parse {driver_label} CA certificate at {ca}: {error}"))?;
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    if let (Some(cert_path), Some(key_path)) = (
        client_cert_path.map(str::trim).filter(|path| !path.is_empty()),
        client_key_path.map(str::trim).filter(|path| !path.is_empty()),
    ) {
        let cert_path = expand_tilde(cert_path);
        let key_path = expand_tilde(key_path);
        let mut pem = std::fs::read(&cert_path)
            .map_err(|error| format!("Failed to read {driver_label} client certificate at {cert_path}: {error}"))?;
        if !pem.ends_with(b"\n") {
            pem.push(b'\n');
        }
        pem.extend(
            std::fs::read(&key_path)
                .map_err(|error| format!("Failed to read {driver_label} client key at {key_path}: {error}"))?,
        );
        let identity = Identity::from_pem(&pem)
            .map_err(|error| format!("Failed to parse {driver_label} client identity: {error}"))?;
        builder = builder.identity(identity);
    }
    Ok(builder)
}

/// Extracts the lowercased URL scheme from a target URL or endpoint (defaults to "https" if unspecified).
pub fn normalize_url_scheme(url: &str) -> String {
    let trimmed = url.trim();
    if let Some((scheme, _)) = trimmed.split_once("://") {
        scheme.to_ascii_lowercase()
    } else {
        "https".to_string()
    }
}

/// Resolves standard environment proxy settings (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and NO_PROXY).
pub fn standard_env_proxy(scheme: &str) -> (Option<String>, Option<String>) {
    let http_proxy = first_non_empty_env(&["HTTP_PROXY", "http_proxy"]);
    let https_proxy = first_non_empty_env(&["HTTPS_PROXY", "https_proxy"]);
    let all_proxy = first_non_empty_env(&["ALL_PROXY", "all_proxy"]);
    let proxy_url = match scheme {
        "https" => https_proxy.or(all_proxy),
        "http" => http_proxy.or(all_proxy),
        _ => https_proxy.or(http_proxy).or(all_proxy),
    };
    let no_proxy = first_non_empty_env(&["NO_PROXY", "no_proxy"]);
    (proxy_url, no_proxy)
}

fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    })
}

/// Resolves an HTTP/HTTPS/SOCKS proxy for a given target URL.
///
/// Priority:
/// 1. `explicit_proxy` (if provided):
///    - "direct", "none", "off", "false": forces direct connection (no proxy).
///    - "env", "auto", "system": forces lookup from environment variables.
///    - Any other string: treated as proxy URL (e.g. "http://proxy:8080", "socks5://proxy:1080").
/// 2. If no explicit proxy:
///    - Checks `DBX_HTTP_PROXY_DISABLE`: if set to true/1/yes, skips proxy.
///    - Resolves from environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`).
///    - Attaches `NO_PROXY` bypass rules if present.
pub fn resolve_http_proxy(
    target_url: &str,
    explicit_proxy: Option<&str>,
    no_proxy: Option<&str>,
) -> Result<Option<reqwest::Proxy>, String> {
    if let Some(explicit) = explicit_proxy.map(str::trim).filter(|s| !s.is_empty()) {
        if matches!(explicit.to_ascii_lowercase().as_str(), "direct" | "none" | "off" | "false") {
            return Ok(None);
        }
        if !matches!(explicit.to_ascii_lowercase().as_str(), "env" | "auto" | "system") {
            let mut proxy = reqwest::Proxy::all(explicit)
                .map_err(|e| format!("Invalid proxy URL '{}': {e}", redact_proxy_userinfo(explicit)))?;
            if let Some(no_proxy_val) = no_proxy.map(str::trim).filter(|s| !s.is_empty()) {
                proxy = proxy.no_proxy(reqwest::NoProxy::from_string(no_proxy_val));
            }
            return Ok(Some(proxy));
        }
    }

    if let Ok(val) = std::env::var("DBX_HTTP_PROXY_DISABLE") {
        if matches!(val.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on") {
            return Ok(None);
        }
    }

    let scheme = normalize_url_scheme(target_url);
    let (proxy_url, env_no_proxy) = standard_env_proxy(&scheme);
    let effective_no_proxy = no_proxy.map(str::trim).filter(|s| !s.is_empty()).or(env_no_proxy.as_deref());

    if let Some(url) = proxy_url {
        let mut proxy = reqwest::Proxy::all(&url)
            .map_err(|e| format!("Invalid environment proxy URL '{}': {e}", redact_proxy_userinfo(&url)))?;
        if let Some(no_proxy_val) = effective_no_proxy {
            proxy = proxy.no_proxy(reqwest::NoProxy::from_string(no_proxy_val));
        }
        Ok(Some(proxy))
    } else {
        Ok(None)
    }
}

/// Redacts userinfo (credentials) from a proxy URL so error messages never leak
/// them into logs: `http://user:pass@proxy:8080` -> `http://proxy:8080`.
fn redact_proxy_userinfo(url: &str) -> String {
    let (prefix, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (format!("{scheme}://"), rest),
        None => (String::new(), url),
    };
    let (authority, path) = match rest.find('/') {
        Some(idx) => rest.split_at(idx),
        None => (rest, ""),
    };
    match authority.rfind('@') {
        Some(at) => format!("{prefix}{}{path}", &authority[at + 1..]),
        None => url.to_string(),
    }
}

/// Applies proxy configuration to a `ClientBuilder`.
///
/// If `explicit_proxy` is provided, it is attached directly.
/// Otherwise, resolves the proxy from `proxy_url` (or environment) and `no_proxy`.
/// If no proxy is applicable, preserves direct connection (`no_proxy()`).
pub fn apply_http_proxy(
    builder: ClientBuilder,
    target_url: &str,
    explicit_proxy: Option<reqwest::Proxy>,
    proxy_url: Option<&str>,
    no_proxy: Option<&str>,
) -> Result<ClientBuilder, String> {
    if let Some(proxy) = explicit_proxy {
        return Ok(builder.proxy(proxy));
    }
    if let Some(proxy) = resolve_http_proxy(target_url, proxy_url, no_proxy)? {
        return Ok(builder.proxy(proxy));
    }
    Ok(builder)
}

/// Parses `proxy` and `no_proxy` options from URL query parameters.
pub fn parse_proxy_url_params(params: Option<&str>) -> (Option<String>, Option<String>) {
    let mut proxy = None;
    let mut no_proxy = None;
    if let Some(params) = params {
        for part in params.trim().trim_start_matches(['?', '&', ';']).split(['&', ';']) {
            if let Some((k, v)) = part.split_once('=') {
                let k = k.trim().to_ascii_lowercase();
                let v = v.trim().to_string();
                if k == "proxy" || k == "http_proxy" || k == "https_proxy" {
                    proxy = Some(v);
                } else if k == "no_proxy" {
                    no_proxy = Some(v);
                }
            }
        }
    }
    (proxy, no_proxy)
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
    use super::{
        apply_tls_certificates, apply_tls_certificates_for_driver, http_client_builder, parse_proxy_url_params,
        redact_proxy_userinfo, resolve_http_proxy,
    };
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

    #[test]
    fn apply_tls_certificates_for_driver_formats_custom_label() {
        let err = apply_tls_certificates_for_driver(
            http_client_builder(Duration::from_secs(5)),
            Some("/nonexistent/custom-ca.pem"),
            None,
            None,
            "Cloudflare D1",
        )
        .err()
        .unwrap();
        assert!(err.contains("Failed to read Cloudflare D1 CA certificate at /nonexistent/custom-ca.pem"));
    }

    /// t8y2 review (PR #12534): the `SSL_CERT_FILE` environment fallback must stay
    /// scoped to the per-driver helper — the legacy `apply_tls_certificates`
    /// wrapper (Elasticsearch/Solr/CouchDB) keeps its bundled-roots-only behavior
    /// when no CA is configured.
    #[test]
    fn ssl_cert_file_env_fallback_is_driver_scoped() {
        let dir = std::env::temp_dir().join(format!("dbx-tls-env-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Point SSL_CERT_FILE at a directory: it exists(), so the env fallback
        // picks it up, but reading it fails — proving the fallback was honored.
        let dir_ca = dir.join("ca-dir");
        std::fs::create_dir_all(&dir_ca).unwrap();
        std::env::set_var("SSL_CERT_FILE", &dir_ca);

        // The per-driver variant honors the environment fallback: the directory
        // is "read" and fails — proving SSL_CERT_FILE was picked up.
        let err = apply_tls_certificates_for_driver(
            http_client_builder(Duration::from_secs(5)),
            None,
            None,
            None,
            "Cloudflare D1",
        )
        .expect_err("driver-scoped helper must honor SSL_CERT_FILE");
        assert!(err.contains("Failed to read Cloudflare D1 CA certificate"), "unexpected error: {err}");

        // The legacy wrapper must ignore SSL_CERT_FILE entirely.
        let ok = apply_tls_certificates(http_client_builder(Duration::from_secs(5)), None, None, None);
        assert!(ok.is_ok(), "legacy wrapper must ignore SSL_CERT_FILE");

        std::env::remove_var("SSL_CERT_FILE");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn redact_proxy_userinfo_strips_credentials() {
        assert_eq!(redact_proxy_userinfo("http://user:pass@proxy:8080"), "http://proxy:8080");
        assert_eq!(redact_proxy_userinfo("socks5://u:p@[::1]:1080/path"), "socks5://[::1]:1080/path");
        assert_eq!(redact_proxy_userinfo("http://proxy:8080"), "http://proxy:8080");
        assert_eq!(redact_proxy_userinfo("user@host:8080"), "host:8080");
        assert_eq!(redact_proxy_userinfo(""), "");
    }

    #[test]
    fn parse_proxy_url_params_extracts_proxy_and_no_proxy() {
        let (proxy, no_proxy) =
            parse_proxy_url_params(Some("?proxy=http://127.0.0.1:8080&no_proxy=localhost,127.0.0.1"));
        assert_eq!(proxy.as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(no_proxy.as_deref(), Some("localhost,127.0.0.1"));

        let (proxy, no_proxy) = parse_proxy_url_params(Some("proxy=direct;no_proxy=.internal"));
        assert_eq!(proxy.as_deref(), Some("direct"));
        assert_eq!(no_proxy.as_deref(), Some(".internal"));

        let (proxy, no_proxy) = parse_proxy_url_params(None);
        assert_eq!(proxy, None);
        assert_eq!(no_proxy, None);
    }

    #[test]
    fn resolve_http_proxy_honors_explicit_direct_directive() {
        let result = resolve_http_proxy("https://api.cloudflare.com/raw", Some("direct"), None).unwrap();
        assert!(result.is_none());

        let result = resolve_http_proxy("https://api.cloudflare.com/raw", Some("none"), None).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn resolve_http_proxy_parses_explicit_url() {
        let proxy =
            resolve_http_proxy("https://api.cloudflare.com/raw", Some("http://proxy.test:8080"), Some("localhost"))
                .unwrap();
        assert!(proxy.is_some());
    }
}
