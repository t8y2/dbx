use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use chrono::Utc;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Method, Url};
use serde::Serialize;

use super::config::S3Config;
use super::sigv4::sign_request;

#[derive(Debug, Clone)]
pub struct S3Client {
    config: S3Config,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3RequestResult {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

impl S3Client {
    pub async fn new(mut config: S3Config) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(config.connect_timeout_secs.max(1)))
            .redirect(reqwest::redirect::Policy::none());
        if config.request_timeout_secs > 0 {
            builder = builder.timeout(Duration::from_secs(config.request_timeout_secs));
        }
        if config.tls_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if let Some((override_host, override_port)) = config.connect_override.clone() {
            let original_host = config.endpoint.host_str().ok_or("S3 endpoint has no host")?.to_string();
            let ip = override_host
                .parse::<IpAddr>()
                .map_err(|_| format!("S3 transport target must resolve to an IP address: {override_host}"))?;
            config
                .endpoint
                .set_port(Some(override_port))
                .map_err(|_| "S3 endpoint cannot use the transport override port".to_string())?;
            builder = builder.resolve(&original_host, SocketAddr::new(ip, override_port));
        }
        let http = builder.build().map_err(|error| format!("Failed to initialize S3 HTTP client: {error}"))?;
        Ok(Self { config, http })
    }

    pub fn config(&self) -> &S3Config {
        &self.config
    }

    pub async fn probe(&self) -> Result<(), String> {
        self.request(Method::GET, self.root_url()?, None, None, None, &[]).await.map(|_| ())
    }

    pub async fn request(
        &self,
        method: Method,
        url: Url,
        query: Option<&[(&str, String)]>,
        payload: Option<&[u8]>,
        content_type: Option<&str>,
        extra_signed_headers: &[(&str, &str)],
    ) -> Result<S3RequestResult, String> {
        let mut url = url;
        if let Some(query) = query.filter(|items| !items.is_empty()) {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        let payload = payload.unwrap_or_default();
        let send_body = !payload.is_empty() || method == Method::PUT || method == Method::POST;
        let signed = sign_request(
            &method,
            &url,
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_access_key,
            Some(&self.config.session_token),
            payload,
            extra_signed_headers,
            Utc::now(),
        )?;
        let mut request = self.http.request(method, url);
        for (name, value) in signed.headers {
            if name.eq_ignore_ascii_case("host") {
                continue;
            }
            request = request.header(name, value);
        }
        if let Some(content_type) = content_type.filter(|value| !value.is_empty()) {
            request = request.header("content-type", content_type);
        }
        if send_body {
            request = request.body(payload.to_vec());
        }
        let response = request.send().await.map_err(|error| format!("S3 request failed: {}", error.without_url()))?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let content_length = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim_matches('"').to_string());
        let last_modified = response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.bytes().await.map_err(|error| format!("Failed to read S3 response body: {error}"))?;
        if !(200..300).contains(&status) {
            let detail = String::from_utf8_lossy(&body);
            return Err(format!("S3 request failed with HTTP {status}: {detail}"));
        }
        Ok(S3RequestResult { status, body: body.to_vec(), content_type, content_length, etag, last_modified })
    }

    pub fn root_url(&self) -> Result<Url, String> {
        Ok(self.config.endpoint.clone())
    }

    pub fn bucket_url(&self, bucket: &str) -> Result<Url, String> {
        let bucket = bucket.trim();
        if bucket.is_empty() {
            return Err("S3 bucket name is required".to_string());
        }
        if self.config.uses_path_style(Some(bucket)) {
            let mut url = self.config.endpoint.clone();
            let path = format!("{}/{}", url.path().trim_end_matches('/'), bucket);
            url.set_path(&path);
            Ok(url)
        } else {
            let host = self.config.endpoint.host_str().ok_or("S3 endpoint has no host")?;
            let mut url = self.config.endpoint.clone();
            url.set_host(Some(&format!("{bucket}.{host}")))
                .map_err(|error| format!("Failed to build virtual-hosted S3 URL: {error}"))?;
            Ok(url)
        }
    }

    pub fn object_url(&self, bucket: &str, key: &str) -> Result<Url, String> {
        let key = normalize_key(key);
        if key.is_empty() {
            return Err("S3 object key is required".to_string());
        }
        let mut url = self.bucket_url(bucket)?;
        if self.config.uses_path_style(Some(bucket)) {
            let path = format!("{}/{}", url.path().trim_end_matches('/'), encode_path_segments(&key));
            url.set_path(&path);
        } else {
            url.set_path(&format!("/{}", encode_path_segments(&key)));
        }
        Ok(url)
    }

    pub fn copy_source_header(&self, bucket: &str, key: &str) -> Result<String, String> {
        let bucket = bucket.trim();
        if bucket.is_empty() {
            return Err("S3 source bucket name is required".to_string());
        }
        let key = normalize_key(key);
        if key.is_empty() {
            return Err("S3 source object key is required".to_string());
        }
        Ok(format!("/{bucket}/{}", encode_path_segments(&key)))
    }
}

pub(crate) async fn ensure_writable_core(
    state: &crate::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), String> {
    if let Some(name) = crate::query::connection_readonly_name(state, connection_id).await {
        return Err(format!("S3_READ_ONLY: connection '{name}' has read-only protection enabled; {action} blocked"));
    }
    Ok(())
}

fn normalize_key(key: &str) -> String {
    key.trim_start_matches('/').to_string()
}

const PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'/')
    .add(b'%')
    .add(b'?')
    .add(b'#')
    .add(b'[')
    .add(b']')
    .add(b'@')
    .add(b'!')
    .add(b'$')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b';')
    .add(b'=');

fn encode_path_segments(key: &str) -> String {
    key.split('/')
        .map(
            |segment| {
                if segment.is_empty() {
                    String::new()
                } else {
                    utf8_percent_encode(segment, PATH_ENCODE_SET).to_string()
                }
            },
        )
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::s3::config::S3AddressingStyle;

    fn test_client(addressing_style: S3AddressingStyle) -> S3Client {
        S3Client {
            config: S3Config {
                endpoint: Url::parse("https://s3.us-east-1.amazonaws.com").unwrap(),
                region: "us-east-1".to_string(),
                access_key_id: "AKIAEXAMPLE".to_string(),
                secret_access_key: "secret".to_string(),
                session_token: String::new(),
                addressing_style,
                default_bucket: String::new(),
                tls_skip_verify: false,
                connect_timeout_secs: 10,
                request_timeout_secs: 10,
                connect_override: None,
            },
            http: reqwest::Client::new(),
        }
    }

    #[test]
    fn object_url_path_style_encodes_special_characters_once() {
        let client = test_client(S3AddressingStyle::Path);
        let url = client.object_url("demo-bucket", "folder/space 中%?.txt").unwrap();
        assert_eq!(url.as_str(), "https://s3.us-east-1.amazonaws.com/demo-bucket/folder/space%20%E4%B8%AD%25%3F.txt");
    }

    #[test]
    fn object_url_virtual_hosted_encodes_special_characters_once() {
        let client = test_client(S3AddressingStyle::VirtualHosted);
        let url = client.object_url("demo-bucket", "folder/space 中%?.txt").unwrap();
        assert_eq!(url.as_str(), "https://demo-bucket.s3.us-east-1.amazonaws.com/folder/space%20%E4%B8%AD%25%3F.txt");
    }

    #[test]
    fn copy_source_header_encodes_special_characters_once() {
        let client = test_client(S3AddressingStyle::Path);
        let header = client.copy_source_header("demo-bucket", "folder/space 中%?.txt").unwrap();
        assert_eq!(header, "/demo-bucket/folder/space%20%E4%B8%AD%25%3F.txt");
    }
}
