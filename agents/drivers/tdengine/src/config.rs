use anyhow::{bail, Context, Result};
use percent_encoding::percent_decode_str;
use std::net::IpAddr;
use url::Url;

use crate::model::ConnectParams;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 6041;
const DEFAULT_USER: &str = "root";
const DEFAULT_PASSWORD: &str = "taosdata";

#[derive(Debug)]
pub struct BuiltDsn {
    pub value: String,
    pub database: String,
}

pub fn build_dsn(params: &ConnectParams) -> Result<BuiltDsn> {
    if !params.client_cert_path.trim().is_empty() || !params.client_key_path.trim().is_empty() {
        bail!("TDengine Rust WebSocket connector does not support client certificate authentication");
    }

    let mut url = if params.connection_string.trim().is_empty() {
        build_from_fields(params)?
    } else {
        normalize_connection_string(params.connection_string.trim(), params.ssl)?
    };

    apply_connection_fields(&mut url, params)?;
    merge_query_params(&mut url, &params.url_params);
    if (params.ssl || !params.ca_cert_path.trim().is_empty()) && url.scheme() == "ws" {
        url.set_scheme("wss").map_err(|_| anyhow::anyhow!("failed to enable TLS in TDengine connection URL"))?;
    }
    if !params.ca_cert_path.trim().is_empty() {
        set_query_param(&mut url, "tls_mode", "verify_identity");
        set_query_param(&mut url, "tls_ca", params.ca_cert_path.trim());
    }
    let database = url
        .path_segments()
        .and_then(|mut segments| segments.find(|segment| !segment.is_empty()))
        .map(|segment| percent_decode_str(segment).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    Ok(BuiltDsn { value: url.into(), database })
}

fn build_from_fields(params: &ConnectParams) -> Result<Url> {
    let scheme = if params.ssl { "wss" } else { "ws" };
    let host = if params.host.trim().is_empty() { DEFAULT_HOST } else { params.host.trim() };
    let port = if params.port == 0 { DEFAULT_PORT } else { params.port };
    let username = if params.username.is_empty() { DEFAULT_USER } else { &params.username };
    let password = if params.password.is_empty() { DEFAULT_PASSWORD } else { &params.password };
    let mut url = Url::parse(&format!("{scheme}://{DEFAULT_HOST}:{port}/"))?;
    if let Ok(address) = host.parse::<IpAddr>() {
        url.set_ip_host(address).map_err(|_| anyhow::anyhow!("invalid TDengine host"))?;
    } else {
        url.set_host(Some(host)).map_err(|_| anyhow::anyhow!("invalid TDengine host"))?;
    }
    url.set_username(username).map_err(|_| anyhow::anyhow!("invalid TDengine username"))?;
    url.set_password(Some(password)).map_err(|_| anyhow::anyhow!("invalid TDengine password"))?;
    if !params.database.trim().is_empty() {
        url.set_path(&format!("/{}", params.database.trim()));
    }
    Ok(url)
}

fn apply_connection_fields(url: &mut Url, params: &ConnectParams) -> Result<()> {
    if url.username().is_empty() {
        let username = if params.username.is_empty() { DEFAULT_USER } else { &params.username };
        url.set_username(username).map_err(|_| anyhow::anyhow!("invalid TDengine username"))?;
    }
    if url.password().is_none() {
        let password = if params.password.is_empty() { DEFAULT_PASSWORD } else { &params.password };
        url.set_password(Some(password)).map_err(|_| anyhow::anyhow!("invalid TDengine password"))?;
    }
    if url.path().trim_matches('/').is_empty() && !params.database.trim().is_empty() {
        url.set_path(&format!("/{}", params.database.trim()));
    }
    Ok(())
}

fn normalize_connection_string(raw: &str, ssl: bool) -> Result<Url> {
    let trimmed = raw.trim();
    let normalized = if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "jdbc:TAOS-WS://") {
        format!("{}://{value}", if ssl { "wss" } else { "ws" })
    } else if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "jdbc:TAOS-RS://") {
        format!("{}://{value}", if ssl { "wss" } else { "ws" })
    } else if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "tdengine://") {
        format!("{}://{value}", if ssl { "wss" } else { "ws" })
    } else if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "taosws://") {
        format!("{}://{value}", if ssl { "wss" } else { "ws" })
    } else if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "taoswss://") {
        format!("wss://{value}")
    } else {
        trimmed.to_string()
    };
    let mut url = Url::parse(&normalized).with_context(|| "invalid TDengine connection string")?;
    if !matches!(url.scheme(), "ws" | "wss" | "http" | "https") {
        bail!("TDengine native agent supports only WebSocket connection strings");
    }
    if matches!(url.scheme(), "http") {
        url.set_scheme("ws").map_err(|_| anyhow::anyhow!("invalid TDengine HTTP connection string"))?;
    } else if matches!(url.scheme(), "https") {
        url.set_scheme("wss").map_err(|_| anyhow::anyhow!("invalid TDengine HTTPS connection string"))?;
    }
    remove_control_params(&mut url);
    Ok(url)
}

fn merge_query_params(url: &mut Url, raw: &str) {
    let raw = raw.trim().trim_start_matches('?');
    if raw.is_empty() {
        return;
    }
    let additions = url::form_urlencoded::parse(raw.as_bytes())
        .filter(|(key, _)| !is_control_param(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let mut query = url.query_pairs_mut();
    for (key, value) in additions {
        query.append_pair(&key, &value);
    }
}

fn remove_control_params(url: &mut Url) {
    let kept = url
        .query_pairs()
        .filter(|(key, _)| !is_control_param(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    if kept.is_empty() {
        return;
    }
    let mut query = url.query_pairs_mut();
    for (key, value) in kept {
        query.append_pair(&key, &value);
    }
}

fn set_query_param(url: &mut Url, key: &str, value: &str) {
    let mut pairs = url
        .query_pairs()
        .filter(|(existing, _)| !existing.eq_ignore_ascii_case(key))
        .map(|(existing, value)| (existing.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    pairs.push((key.to_string(), value.to_string()));
    url.set_query(None);
    let mut query = url.query_pairs_mut();
    for (key, value) in pairs {
        query.append_pair(&key, &value);
    }
}

fn is_control_param(key: &str) -> bool {
    key.eq_ignore_ascii_case("transport") || key.eq_ignore_ascii_case("dbx.transport")
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value.get(..prefix.len()).filter(|head| head.eq_ignore_ascii_case(prefix))?;
    value.get(prefix.len()..)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ws_dsn_from_connection_fields() {
        let dsn = build_dsn(&ConnectParams {
            host: "db.example.com".into(),
            port: 6041,
            database: "power_data".into(),
            username: "root".into(),
            password: "secret".into(),
            url_params: "timezone=UTC&dbx.transport=rest".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(dsn.value, "ws://root:secret@db.example.com:6041/power_data?timezone=UTC");
        assert_eq!(dsn.database, "power_data");
    }

    #[test]
    fn accepts_legacy_jdbc_urls_without_transport_controls() {
        let dsn = build_dsn(&ConnectParams {
            connection_string: "jdbc:TAOS-WS://127.0.0.1:6041/db?transport=ws&timezone=UTC".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(dsn.value, "ws://root:taosdata@127.0.0.1:6041/db?timezone=UTC");
        assert_eq!(dsn.database, "db");
    }

    #[test]
    fn fills_connection_string_credentials_and_database_from_fields() {
        let dsn = build_dsn(&ConnectParams {
            username: "reader".into(),
            password: "secret".into(),
            database: "metrics".into(),
            connection_string: "jdbc:TAOS-WS://td.example.com:6041?transport=ws".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(dsn.value, "ws://reader:secret@td.example.com:6041/metrics");
        assert_eq!(dsn.database, "metrics");
    }

    #[test]
    fn preserves_explicit_connection_string_credentials_and_database() {
        let dsn = build_dsn(&ConnectParams {
            username: "ignored".into(),
            password: "ignored".into(),
            database: "ignored".into(),
            connection_string: "ws://url-user:url-pass@td.example.com:6041/url-db".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(dsn.value, "ws://url-user:url-pass@td.example.com:6041/url-db");
        assert_eq!(dsn.database, "url-db");
    }

    #[test]
    fn passes_ca_certificate_path_to_the_websocket_connector() {
        let dsn =
            build_dsn(&ConnectParams { ssl: true, ca_cert_path: "/tmp/tdengine-ca.pem".into(), ..Default::default() })
                .unwrap();
        let url = Url::parse(&dsn.value).unwrap();
        assert_eq!(url.scheme(), "wss");
        let query = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
        assert_eq!(query.get("tls_mode").map(|value| value.as_ref()), Some("verify_identity"));
        assert_eq!(query.get("tls_ca").map(|value| value.as_ref()), Some("/tmp/tdengine-ca.pem"));
    }

    #[test]
    fn rejects_mutual_tls_paths_instead_of_ignoring_them() {
        let error =
            build_dsn(&ConnectParams { client_cert_path: "/tmp/client.pem".into(), ..Default::default() }).unwrap_err();
        assert!(error.to_string().contains("client certificate"));
    }

    #[test]
    fn ca_certificate_enables_tls_and_replaces_conflicting_query_values() {
        let dsn = build_dsn(&ConnectParams {
            connection_string: "ws://td.example.com:6041/db?tls_mode=verify_ca&tls_ca=old.pem".into(),
            ca_cert_path: "/tmp/new-ca.pem".into(),
            ..Default::default()
        })
        .unwrap();
        let url = Url::parse(&dsn.value).unwrap();
        assert_eq!(url.scheme(), "wss");
        let tls_mode = url.query_pairs().filter(|(key, _)| key == "tls_mode").collect::<Vec<_>>();
        let tls_ca = url.query_pairs().filter(|(key, _)| key == "tls_ca").collect::<Vec<_>>();
        assert_eq!(tls_mode.as_slice(), &[("tls_mode".into(), "verify_identity".into())]);
        assert_eq!(tls_ca.as_slice(), &[("tls_ca".into(), "/tmp/new-ca.pem".into())]);
    }

    #[test]
    fn supports_ipv6_hosts_and_decodes_connection_database() {
        let fields =
            build_dsn(&ConnectParams { host: "::1".into(), database: "power data".into(), ..Default::default() })
                .unwrap();
        assert_eq!(fields.value, "ws://root:taosdata@[::1]:6041/power%20data");
        assert_eq!(fields.database, "power data");

        let connection = build_dsn(&ConnectParams {
            connection_string: "taoswss://td.example.com:6041/power%20data".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(connection.value, "wss://root:taosdata@td.example.com:6041/power%20data");
        assert_eq!(connection.database, "power data");
    }
}
