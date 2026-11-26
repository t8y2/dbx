use anyhow::{bail, Context, Result};
use std::net::IpAddr;
use url::Url;

use crate::model::ConnectParams;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 8902;
pub const DEFAULT_USER: &str = "root";
pub const DEFAULT_PASSWORD: &str = "";
pub const DEFAULT_DATABASE: &str = "public";
pub const DEFAULT_TENANT: &str = "cnosdb";

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub database: String,
    pub tenant: String,
    pub username: String,
    pub password: String,
    pub connect_timeout_secs: u64,
}

pub fn build_endpoint(params: &ConnectParams) -> Result<Endpoint> {
    if !params.client_cert_path.trim().is_empty() || !params.client_key_path.trim().is_empty() {
        bail!("CnosDB HTTP agent does not support client certificate authentication");
    }
    if !params.ca_cert_path.trim().is_empty() {
        bail!("CnosDB HTTP agent does not support a custom CA certificate path");
    }

    let (mut url, database_from_url, tenant_from_url) = if params.connection_string.trim().is_empty() {
        (build_from_fields(params)?, None, None)
    } else {
        normalize_connection_string(params.connection_string.trim(), params.ssl)?
    };

    apply_connection_fields(&mut url, params)?;
    merge_query_params(&mut url, &params.url_params);

    let database = first_non_empty(&[
        params.database.trim(),
        database_from_url.as_deref().unwrap_or(""),
        url.path_segments().and_then(|mut segments| segments.find(|segment| !segment.is_empty())).unwrap_or(""),
        DEFAULT_DATABASE,
    ]);
    let tenant = first_non_empty(&[
        params.tenant.trim(),
        tenant_from_url.as_deref().unwrap_or(""),
        query_value(&url, "tenant").as_deref().unwrap_or(""),
        DEFAULT_TENANT,
    ]);
    let username = if params.username.trim().is_empty() {
        if url.username().is_empty() {
            DEFAULT_USER.to_string()
        } else {
            url.username().to_string()
        }
    } else {
        params.username.trim().to_string()
    };
    let password = if !params.password.is_empty() {
        params.password.clone()
    } else {
        url.password().unwrap_or(DEFAULT_PASSWORD).to_string()
    };

    // Strip credentials from the base URL; auth is sent via Basic headers.
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_path("/");
    url.set_query(None);
    let mut base: String = url.into();
    if !base.ends_with('/') {
        base.push('/');
    }

    Ok(Endpoint {
        base_url: base,
        database,
        tenant,
        username,
        password,
        connect_timeout_secs: if params.connect_timeout_secs == 0 { 15 } else { params.connect_timeout_secs },
    })
}

fn build_from_fields(params: &ConnectParams) -> Result<Url> {
    let scheme = if params.ssl { "https" } else { "http" };
    let host = if params.host.trim().is_empty() { DEFAULT_HOST } else { params.host.trim() };
    let port = if params.port == 0 { DEFAULT_PORT } else { params.port };
    let mut url = Url::parse(&format!("{scheme}://{DEFAULT_HOST}:{port}/"))?;
    if let Ok(address) = host.parse::<IpAddr>() {
        url.set_ip_host(address).map_err(|_| anyhow::anyhow!("invalid CnosDB host"))?;
    } else {
        url.set_host(Some(host)).map_err(|_| anyhow::anyhow!("invalid CnosDB host"))?;
    }
    Ok(url)
}

fn apply_connection_fields(url: &mut Url, params: &ConnectParams) -> Result<()> {
    if url.port_or_known_default().is_none() && params.port != 0 {
        url.set_port(Some(params.port)).map_err(|_| anyhow::anyhow!("invalid CnosDB port"))?;
    }
    if (url.scheme() == "http" || url.scheme() == "https") && url.port().is_none() && params.port == 0 {
        url.set_port(Some(DEFAULT_PORT)).map_err(|_| anyhow::anyhow!("invalid CnosDB port"))?;
    }
    Ok(())
}

fn normalize_connection_string(raw: &str, ssl: bool) -> Result<(Url, Option<String>, Option<String>)> {
    let trimmed = raw.trim();
    let normalized = if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "cnosdb://") {
        format!("{}://{value}", if ssl { "https" } else { "http" })
    } else if let Some(value) = strip_prefix_ignore_ascii_case(trimmed, "jdbc:arrow-flight-sql://") {
        // Flight SQL URLs still carry host/port; HTTP API commonly shares the host on 8902.
        format!("{}://{value}", if ssl { "https" } else { "http" })
    } else {
        trimmed.to_string()
    };
    let mut url = Url::parse(&normalized).with_context(|| "invalid CnosDB connection string")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("CnosDB native agent supports only HTTP(S) connection strings");
    }
    if ssl && url.scheme() == "http" {
        url.set_scheme("https").map_err(|_| anyhow::anyhow!("failed to enable TLS in CnosDB connection URL"))?;
    }
    let database =
        url.path_segments().and_then(|mut segments| segments.find(|segment| !segment.is_empty())).map(str::to_string);
    let tenant = query_value(&url, "tenant");
    Ok((url, database, tenant))
}

fn merge_query_params(url: &mut Url, raw: &str) {
    let raw = raw.trim().trim_start_matches('?');
    if raw.is_empty() {
        return;
    }
    let additions = url::form_urlencoded::parse(raw.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let mut query = url.query_pairs_mut();
    for (key, value) in additions {
        query.append_pair(&key, &value);
    }
}

fn query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(existing, _)| existing.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.trim().is_empty())
}

fn first_non_empty(values: &[&str]) -> String {
    values.iter().map(|value| value.trim()).find(|value| !value.is_empty()).unwrap_or_default().to_string()
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value.get(..prefix.len()).filter(|head| head.eq_ignore_ascii_case(prefix))?;
    value.get(prefix.len()..)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_http_endpoint_with_defaults() {
        let endpoint = build_endpoint(&ConnectParams {
            host: "db.example.com".into(),
            port: 8902,
            database: "metrics".into(),
            username: "root".into(),
            password: "secret".into(),
            tenant: "acme".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(endpoint.base_url, "http://db.example.com:8902/");
        assert_eq!(endpoint.database, "metrics");
        assert_eq!(endpoint.tenant, "acme");
        assert_eq!(endpoint.username, "root");
        assert_eq!(endpoint.password, "secret");
    }

    #[test]
    fn reads_tenant_from_url_params() {
        let endpoint = build_endpoint(&ConnectParams {
            host: "127.0.0.1".into(),
            url_params: "tenant=demo".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(endpoint.tenant, "demo");
        assert_eq!(endpoint.database, "public");
        assert_eq!(endpoint.password, "");
    }

    #[test]
    fn rejects_mutual_tls_paths() {
        let error = build_endpoint(&ConnectParams { client_cert_path: "/tmp/client.pem".into(), ..Default::default() })
            .unwrap_err();
        assert!(error.to_string().contains("client certificate"));

        let error =
            build_endpoint(&ConnectParams { ca_cert_path: "/tmp/ca.pem".into(), ..Default::default() }).unwrap_err();
        assert!(error.to_string().contains("custom CA certificate"));
    }
}
