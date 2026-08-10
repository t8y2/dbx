use async_trait::async_trait;
use http::{header::HeaderName, Method, Request};
use quick_xml::{events::Event, Reader};
use reqsign::aws::{RequestSigner, StaticCredentialProvider, EMPTY_STRING_SHA256};
use reqsign::{Context, Signer};
use reqwest::{Client, StatusCode, Url};
use sha2::{Digest, Sha256};

use super::transport::{S3ObjectTransport, S3TransportError};
use super::{S3AddressingStyle, S3SyncConfig};

pub(crate) struct ReqwestSigV4Transport {
    client: Client,
    signer: Signer<reqsign::aws::Credential>,
    endpoint: Url,
    bucket: String,
    addressing_style: S3AddressingStyle,
}

impl ReqwestSigV4Transport {
    pub(crate) fn new(config: &S3SyncConfig) -> Result<Self, S3TransportError> {
        let region = config.normalized_region();
        let bucket = required_value(&config.bucket, "bucket")?;
        let access_key_id = required_optional_value(config.access_key_id.as_deref(), "access key id")?;
        let secret_access_key = required_optional_value(config.secret_access_key.as_deref(), "secret access key")?;
        let endpoint = config.normalized_endpoint().unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
        let endpoint = Url::parse(&endpoint)
            .map_err(|error| S3TransportError::InvalidConfig(format!("endpoint is not a valid URL: {error}")))?;
        if !matches!(endpoint.scheme(), "http" | "https") {
            return Err(S3TransportError::InvalidConfig("endpoint must use HTTP or HTTPS".to_string()));
        }
        if endpoint.host_str().is_none() {
            return Err(S3TransportError::InvalidConfig("endpoint must include a host".to_string()));
        }
        if endpoint.query().is_some() || endpoint.fragment().is_some() {
            return Err(S3TransportError::InvalidConfig(
                "endpoint must not include a query string or fragment".to_string(),
            ));
        }

        let mut credential = StaticCredentialProvider::new(&access_key_id, &secret_access_key);
        if let Some(session_token) = config.normalized_session_token() {
            credential = credential.with_session_token(&session_token);
        }
        let signer = Signer::new(Context::new(), credential, RequestSigner::new("s3", &region));

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| S3TransportError::InvalidConfig(format!("failed to create HTTP client: {error}")))?;

        Ok(Self { client, signer, endpoint, bucket, addressing_style: config.effective_addressing_style() })
    }

    fn request_url(&self, object_key: Option<&str>) -> Result<Url, S3TransportError> {
        let mut url = self.endpoint.clone();
        if self.addressing_style == S3AddressingStyle::Path {
            let mut segments = url.path_segments_mut().map_err(|_| {
                S3TransportError::InvalidConfig("endpoint cannot be used as an S3 base URL".to_string())
            })?;
            segments.pop_if_empty().push(&self.bucket);
            if let Some(key) = object_key {
                for segment in normalized_object_key(key)?.split('/') {
                    segments.push(segment);
                }
            }
        } else {
            let host = url
                .host_str()
                .ok_or_else(|| S3TransportError::InvalidConfig("endpoint must include a host".to_string()))?;
            let bucket_host = format!("{}.{}", self.bucket, host);
            url.set_host(Some(&bucket_host)).map_err(|_| {
                S3TransportError::InvalidConfig("bucket cannot be used in a virtual-hosted URL".to_string())
            })?;
            let mut segments = url.path_segments_mut().map_err(|_| {
                S3TransportError::InvalidConfig("endpoint cannot be used as an S3 base URL".to_string())
            })?;
            segments.pop_if_empty();
            if let Some(key) = object_key {
                for segment in normalized_object_key(key)?.split('/') {
                    segments.push(segment);
                }
            }
        }
        Ok(url)
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, S3TransportError> {
        let payload_hash =
            if body.is_empty() { EMPTY_STRING_SHA256.to_string() } else { format!("{:x}", Sha256::digest(&body)) };
        let mut builder =
            Request::builder().method(method.clone()).uri(url.as_str()).header("x-amz-content-sha256", payload_hash);
        if let Some(content_type) = content_type {
            builder = builder.header(http::header::CONTENT_TYPE, content_type);
        }
        let request = builder
            .body(())
            .map_err(|error| S3TransportError::InvalidConfig(format!("failed to build request: {error}")))?;
        let (mut parts, _) = request.into_parts();
        self.signer
            .sign(&mut parts, None)
            .await
            .map_err(|error| S3TransportError::Protocol(format!("failed to sign request: {error}")))?;

        let mut request = self.client.request(method, parts.uri.to_string());
        for (name, value) in &parts.headers {
            request = request.header(name, value);
        }
        if !body.is_empty() {
            request = request.body(body);
        }
        request.send().await.map_err(|error| S3TransportError::Network(error.to_string()))
    }

    async fn response_error(response: reqwest::Response, operation: &str) -> S3TransportError {
        let status = response.status();
        let request_id = response
            .headers()
            .get(HeaderName::from_static("x-amz-request-id"))
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.text().await.unwrap_or_default();
        let detail = s3_error_detail(&body)
            .or(request_id.map(|id| format!("request id {id}")))
            .unwrap_or_else(|| format!("HTTP {status}"));
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                S3TransportError::Unauthorized(format!("{operation} failed: {detail}"))
            }
            StatusCode::NOT_FOUND => S3TransportError::NotFound(format!("{operation} failed: {detail}")),
            _ => S3TransportError::Protocol(format!("{operation} failed with HTTP {status}: {detail}")),
        }
    }
}

#[async_trait]
impl S3ObjectTransport for ReqwestSigV4Transport {
    async fn head_bucket(&self) -> Result<(), S3TransportError> {
        let response = self.send(Method::HEAD, self.request_url(None)?, Vec::new(), None).await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::response_error(response, "bucket test").await)
        }
    }

    async fn put_object(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<(), S3TransportError> {
        let response = self.send(Method::PUT, self.request_url(Some(key))?, body, Some(content_type)).await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::response_error(response, "upload").await)
        }
    }

    async fn get_object(&self, key: &str) -> Result<Vec<u8>, S3TransportError> {
        let response = self.send(Method::GET, self.request_url(Some(key))?, Vec::new(), None).await?;
        if !response.status().is_success() {
            return Err(Self::response_error(response, "download").await);
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| S3TransportError::Network(format!("failed to read download response: {error}")))
    }
}

fn required_value(value: &str, field: &str) -> Result<String, S3TransportError> {
    let value = value.trim();
    if value.is_empty() {
        Err(S3TransportError::InvalidConfig(format!("{field} is required")))
    } else {
        Ok(value.to_string())
    }
}

fn required_optional_value(value: Option<&str>, field: &str) -> Result<String, S3TransportError> {
    required_value(value.unwrap_or_default(), field)
}

fn normalized_object_key(value: &str) -> Result<&str, S3TransportError> {
    let value = value.trim().trim_start_matches('/');
    if value.is_empty() {
        Err(S3TransportError::InvalidConfig("object key is required".to_string()))
    } else {
        Ok(value)
    }
}

#[derive(Clone, Copy)]
enum S3ErrorField {
    Code,
    Message,
}

fn s3_error_detail(body: &str) -> Option<String> {
    let mut reader = Reader::from_str(body);
    reader.config_mut().trim_text(true);
    let mut field = None;
    let mut code = None;
    let mut message = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                field = match element.local_name().as_ref() {
                    b"Code" => Some(S3ErrorField::Code),
                    b"Message" => Some(S3ErrorField::Message),
                    _ => None,
                };
            }
            Ok(Event::Text(text)) => {
                let Some(field) = field else { continue };
                let Ok(value) = text.unescape() else { continue };
                let value = value.trim();
                if value.is_empty() {
                    continue;
                }
                match field {
                    S3ErrorField::Code => code = Some(value.to_string()),
                    S3ErrorField::Message => message = Some(value.to_string()),
                }
            }
            Ok(Event::End(_)) => field = None,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    match (code, message) {
        (Some(code), Some(message)) => Some(format!("{code}: {message}")),
        (Some(code), None) => Some(code),
        (None, Some(message)) => Some(message),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_sync::{
        apply_sync_snapshot, build_sync_snapshot_with_saved_secrets, save_webdav_sync_secrets_preference,
        ApplySnapshotOptions, S3SyncClient,
    };
    use crate::storage::Storage;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    fn config(endpoint: Option<String>, addressing_style: Option<S3AddressingStyle>) -> S3SyncConfig {
        S3SyncConfig {
            endpoint,
            region: "eu-west-2".to_string(),
            bucket: "dbx-sync".to_string(),
            access_key_id: Some("test-access-key".to_string()),
            secret_access_key: Some("test-secret-key".to_string()),
            session_token: Some("test-session-token".to_string()),
            object_key: None,
            addressing_style,
        }
    }

    async fn mock_server(status: u16, response_body: &[u8]) -> (String, JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let response_body = response_body.to_vec();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (header_end, content_length) = loop {
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0, "connection closed before request headers completed");
                request.extend_from_slice(&buffer[..read]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let header_end = index + 4;
                    let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
                    let content_length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (header_end, content_length);
                }
            };
            while request.len() < header_end + content_length {
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0, "connection closed before request body completed");
                request.extend_from_slice(&buffer[..read]);
            }
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&response_body).await.unwrap();
            request
        });
        (endpoint, handle)
    }

    #[test]
    fn builds_path_and_virtual_host_urls_with_single_encoding() {
        let path_style =
            ReqwestSigV4Transport::new(&config(Some("https://storage.example.test/base/".to_string()), None)).unwrap();
        assert_eq!(
            path_style.request_url(Some("folder/a b/%/snow-雪.json")).unwrap().as_str(),
            "https://storage.example.test/base/dbx-sync/folder/a%20b/%25/snow-%E9%9B%AA.json"
        );

        let virtual_host = ReqwestSigV4Transport::new(&config(None, None)).unwrap();
        assert_eq!(
            virtual_host.request_url(Some("folder//snapshot.json")).unwrap().as_str(),
            "https://dbx-sync.s3.eu-west-2.amazonaws.com/folder//snapshot.json"
        );
    }

    #[test]
    fn parses_s3_error_xml_without_returning_the_raw_response() {
        assert_eq!(
            s3_error_detail("<Error><Code>InvalidRequest</Code><Message>A &amp; B</Message></Error>").as_deref(),
            Some("InvalidRequest: A & B")
        );
        assert_eq!(s3_error_detail("not xml"), None);
    }

    #[tokio::test]
    async fn matches_aws_s3_sigv4_get_object_test_vector() {
        let mut config = config(Some("https://s3.amazonaws.com".to_string()), Some(S3AddressingStyle::VirtualHosted));
        config.region = "us-east-1".to_string();
        config.bucket = "examplebucket".to_string();
        config.access_key_id = Some("AKIAIOSFODNN7EXAMPLE".to_string());
        config.secret_access_key = Some("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string());
        config.session_token = None;
        let transport = ReqwestSigV4Transport::new(&config).unwrap();
        let request = Request::builder()
            .method(Method::GET)
            .uri(transport.request_url(Some("test.txt")).unwrap().as_str())
            .header("range", "bytes=0-9")
            .header("x-amz-content-sha256", EMPTY_STRING_SHA256)
            .body(())
            .unwrap();
        let (mut parts, _) = request.into_parts();

        transport.signer.sign(&mut parts, None).await.unwrap();

        let canonical_request = |timestamp: &str| {
            format!(
                "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:{EMPTY_STRING_SHA256}\nx-amz-date:{timestamp}\n\nhost;range;x-amz-content-sha256;x-amz-date\n{EMPTY_STRING_SHA256}"
            )
        };
        let official_canonical_hash = format!("{:x}", Sha256::digest(canonical_request("20130524T000000Z")));
        assert_eq!(official_canonical_hash, "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
        let official_scope = "20130524/us-east-1/s3/aws4_request";
        let official_string_to_sign =
            format!("AWS4-HMAC-SHA256\n20130524T000000Z\n{official_scope}\n{official_canonical_hash}");
        assert_eq!(
            sigv4_signature(
                "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                "20130524",
                "us-east-1",
                "s3",
                &official_string_to_sign,
            ),
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );

        let timestamp = parts.headers["x-amz-date"].to_str().unwrap();
        let date = &timestamp[..8];
        let scope = format!("{date}/us-east-1/s3/aws4_request");
        let canonical_hash = format!("{:x}", Sha256::digest(canonical_request(timestamp)));
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{canonical_hash}");
        let signature =
            sigv4_signature("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", date, "us-east-1", "s3", &string_to_sign);
        assert_eq!(
            parts.headers[http::header::AUTHORIZATION].to_str().unwrap(),
            format!(
                "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/{scope}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature={signature}"
            )
        );
    }

    fn sigv4_signature(secret: &str, date: &str, region: &str, service: &str, string_to_sign: &str) -> String {
        let date_key = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
        let region_key = hmac_sha256(&date_key, region.as_bytes());
        let service_key = hmac_sha256(&region_key, service.as_bytes());
        let signing_key = hmac_sha256(&service_key, b"aws4_request");
        hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes()))
    }

    fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
        let mut normalized_key = [0_u8; 64];
        if key.len() > normalized_key.len() {
            normalized_key[..32].copy_from_slice(&Sha256::digest(key));
        } else {
            normalized_key[..key.len()].copy_from_slice(key);
        }
        let mut inner_pad = [0x36_u8; 64];
        let mut outer_pad = [0x5c_u8; 64];
        for index in 0..normalized_key.len() {
            inner_pad[index] ^= normalized_key[index];
            outer_pad[index] ^= normalized_key[index];
        }
        let mut inner = Sha256::new();
        inner.update(inner_pad);
        inner.update(message);
        let mut outer = Sha256::new();
        outer.update(outer_pad);
        outer.update(inner.finalize());
        outer.finalize().to_vec()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[tokio::test]
    async fn put_signs_wire_request_with_payload_hash_and_session_token() {
        let (endpoint, request_handle) = mock_server(200, b"").await;
        let transport = ReqwestSigV4Transport::new(&config(Some(endpoint), None)).unwrap();
        transport.put_object("folder/a b/%/snow-雪.json", b"snapshot-body".to_vec(), "application/json").await.unwrap();

        let request = String::from_utf8(request_handle.await.unwrap()).unwrap();
        let headers = request.to_ascii_lowercase();
        assert!(request.starts_with("PUT /dbx-sync/folder/a%20b/%25/snow-%E9%9B%AA.json HTTP/1.1\r\n"));
        assert!(headers.contains("authorization: aws4-hmac-sha256 credential=test-access-key/"));
        assert!(headers.contains("/eu-west-2/s3/aws4_request"));
        assert!(headers.contains("x-amz-security-token: test-session-token"));
        assert!(headers.contains(&format!("x-amz-content-sha256: {:x}", Sha256::digest(b"snapshot-body"))));
        assert!(headers.contains("content-type: application/json"));
        assert!(request.ends_with("\r\n\r\nsnapshot-body"));
    }

    #[tokio::test]
    async fn head_and_get_use_expected_methods_and_map_protocol_errors() {
        let (endpoint, request_handle) = mock_server(200, b"").await;
        let transport = ReqwestSigV4Transport::new(&config(Some(endpoint), None)).unwrap();
        transport.head_bucket().await.unwrap();
        let request = String::from_utf8(request_handle.await.unwrap()).unwrap();
        assert!(request.starts_with("HEAD /dbx-sync HTTP/1.1\r\n"));

        let (endpoint, request_handle) = mock_server(200, b"snapshot-json").await;
        let transport = ReqwestSigV4Transport::new(&config(Some(endpoint), None)).unwrap();
        assert_eq!(transport.get_object("snapshot.json").await.unwrap(), b"snapshot-json");
        let request = String::from_utf8(request_handle.await.unwrap()).unwrap();
        assert!(request.starts_with("GET /dbx-sync/snapshot.json HTTP/1.1\r\n"));

        let (endpoint, _) =
            mock_server(403, b"<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>").await;
        let transport = ReqwestSigV4Transport::new(&config(Some(endpoint), None)).unwrap();
        assert_eq!(
            transport.get_object("snapshot.json").await.unwrap_err(),
            S3TransportError::Unauthorized("download failed: AccessDenied: Denied".to_string())
        );
    }

    #[tokio::test]
    #[ignore = "requires a local MinIO instance configured through DBX_S3_TEST_* variables"]
    async fn minio_path_style_overwrite_and_encrypted_snapshot_round_trip() {
        let endpoint = std::env::var("DBX_S3_TEST_ENDPOINT").expect("DBX_S3_TEST_ENDPOINT");
        let access_key_id = std::env::var("DBX_S3_TEST_ACCESS_KEY_ID").expect("DBX_S3_TEST_ACCESS_KEY_ID");
        let secret_access_key = std::env::var("DBX_S3_TEST_SECRET_ACCESS_KEY").expect("DBX_S3_TEST_SECRET_ACCESS_KEY");
        let bucket = std::env::var("DBX_S3_TEST_BUCKET").unwrap_or_else(|_| "dbx-sync-test".to_string());
        let config = S3SyncConfig {
            endpoint: Some(endpoint),
            region: "us-east-1".to_string(),
            bucket: bucket.clone(),
            access_key_id: Some(access_key_id),
            secret_access_key: Some(secret_access_key),
            session_token: None,
            object_key: Some("DBX/sync/minio-test.json".to_string()),
            addressing_style: Some(S3AddressingStyle::Path),
        };
        let transport = ReqwestSigV4Transport::new(&config).unwrap();
        let create_response =
            transport.send(Method::PUT, transport.request_url(None).unwrap(), Vec::new(), None).await.unwrap();
        assert!(create_response.status().is_success() || create_response.status() == StatusCode::CONFLICT);
        transport.head_bucket().await.unwrap();

        let source_dir = tempfile::tempdir().unwrap();
        let source = Storage::open(&source_dir.path().join("source.db")).await.unwrap();
        save_webdav_sync_secrets_preference(&source, true, Some("shared-sync-passphrase")).await.unwrap();
        let client =
            S3SyncClient { transport: Arc::new(transport), bucket, object_key: config.normalized_object_key() };
        let first = build_sync_snapshot_with_saved_secrets(
            &source,
            "first-version",
            Some(serde_json::json!({ "fontSize": 12 })),
            None,
        )
        .await
        .unwrap();
        client.put_snapshot(&first).await.unwrap();
        let second = build_sync_snapshot_with_saved_secrets(
            &source,
            "second-version",
            Some(serde_json::json!({ "fontSize": 14 })),
            None,
        )
        .await
        .unwrap();
        client.put_snapshot(&second).await.unwrap();

        let (downloaded, _) = client.get_snapshot().await.unwrap();
        assert_eq!(downloaded.app_version, "second-version");
        assert_eq!(downloaded.editor_settings, Some(serde_json::json!({ "fontSize": 14 })));
        assert!(downloaded.encrypted_secrets.is_some());

        let target_dir = tempfile::tempdir().unwrap();
        let target = Storage::open(&target_dir.path().join("target.db")).await.unwrap();
        let apply_summary = apply_sync_snapshot(
            &target,
            &downloaded,
            ApplySnapshotOptions { secrets_passphrase: Some("shared-sync-passphrase"), restore_secrets: true },
        )
        .await
        .unwrap();
        assert!(apply_summary.encrypted_secrets_present);
        assert!(apply_summary.secrets_applied);
    }
}
