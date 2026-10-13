use std::io::{Cursor, Read, Write};

use reqwest::{Response, StatusCode};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::SyncSnapshot;

const SNAPSHOT_ENTRY: &str = "snapshot.json";
const MAX_ZIP_SNAPSHOT_BYTES: u64 = 100 * 1024 * 1024;
const ZIP_SIZE_ERROR: &str = "WebDAV ZIP snapshot exceeds the 100 MiB archive or uncompressed size limit";

pub(super) fn encode(snapshot: &SyncSnapshot, remote_path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let json = serde_json::to_vec_pretty(snapshot).map_err(|error| error.to_string())?;
    if !remote_path.rsplit_once('.').is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("zip")) {
        return Ok((json, "application/json"));
    }
    if json.len() as u64 > MAX_ZIP_SNAPSHOT_BYTES {
        return Err(ZIP_SIZE_ERROR.to_string());
    }
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o600);
    archive
        .start_file(SNAPSHOT_ENTRY, options)
        .map_err(|error| format!("Cannot create WebDAV ZIP snapshot: {error}"))?;
    archive.write_all(&json).map_err(|error| format!("Cannot write WebDAV ZIP snapshot: {error}"))?;
    let bytes = archive.finish().map_err(|error| format!("Cannot finish WebDAV ZIP snapshot: {error}"))?.into_inner();
    if bytes.len() as u64 > MAX_ZIP_SNAPSHOT_BYTES {
        return Err(ZIP_SIZE_ERROR.to_string());
    }
    Ok((bytes, "application/zip"))
}

pub(super) async fn read_response(response: Response) -> Result<Vec<u8>, String> {
    read_response_with_limit(response, MAX_ZIP_SNAPSHOT_BYTES).await
}

async fn read_response_with_limit(mut response: Response, archive_limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        bytes.extend_from_slice(&chunk);
        if is_zip(&bytes) && bytes.len() as u64 > archive_limit {
            return Err(ZIP_SIZE_ERROR.to_string());
        }
    }
    Ok(bytes)
}

pub(super) fn decode(bytes: &[u8]) -> Result<SyncSnapshot, String> {
    if !is_zip(bytes) {
        return serde_json::from_slice(bytes).map_err(|error| error.to_string());
    }
    if bytes.len() as u64 > MAX_ZIP_SNAPSHOT_BYTES {
        return Err(ZIP_SIZE_ERROR.to_string());
    }
    decode_zip(bytes, MAX_ZIP_SNAPSHOT_BYTES)
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK")
}

fn decode_zip(bytes: &[u8], uncompressed_limit: u64) -> Result<SyncSnapshot, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("Invalid WebDAV ZIP snapshot: {error}"))?;
    if archive.len() != 1 {
        return Err("WebDAV ZIP snapshot must contain only snapshot.json".to_string());
    }
    let mut entry = archive.by_index(0).map_err(|error| format!("Invalid WebDAV ZIP snapshot entry: {error}"))?;
    if entry.name() != SNAPSHOT_ENTRY || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
        return Err("WebDAV ZIP snapshot must contain a regular snapshot.json file".to_string());
    }
    if entry.size() > uncompressed_limit {
        return Err(ZIP_SIZE_ERROR.to_string());
    }
    let mut json = Vec::new();
    entry
        .by_ref()
        .take(uncompressed_limit + 1)
        .read_to_end(&mut json)
        .map_err(|error| format!("Cannot read WebDAV ZIP snapshot: {error}"))?;
    if json.len() as u64 > uncompressed_limit {
        return Err(ZIP_SIZE_ERROR.to_string());
    }
    serde_json::from_slice(&json).map_err(|error| format!("Invalid WebDAV ZIP snapshot JSON: {error}"))
}

pub(super) fn upload_error(status: StatusCode, content_type: &str) -> String {
    let mut message = format!("WebDAV upload failed with HTTP {status}");
    if matches!(status, StatusCode::FORBIDDEN | StatusCode::METHOD_NOT_ALLOWED | StatusCode::UNSUPPORTED_MEDIA_TYPE) {
        message.push_str(". Check the account's write permissions, allowed client applications and file types.");
        if content_type == "application/json" {
            message.push_str(" If the service requires ZIP files, use a remote snapshot path ending in .zip (for example DBX/sync/snapshot.zip).");
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::super::{EncryptedSecretsBlob, SyncSelection, WebDavClient, WebDavConfig, SNAPSHOT_SCHEMA_VERSION};
    use super::*;

    fn snapshot() -> SyncSnapshot {
        SyncSnapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            exported_at: "2026-10-09T00:00:00Z".to_string(),
            app_version: "test-version".to_string(),
            connections: Vec::new(),
            mqtt_subscriptions: Some(Vec::new()),
            tunnel_profiles: Some(Vec::new()),
            sidebar_layout: None,
            pinned_tree_node_ids: Vec::new(),
            saved_sql: Default::default(),
            desktop_settings: Default::default(),
            editor_settings: Some(serde_json::json!({"theme": "dark", "label": "测试"})),
            encrypted_secrets: Some(EncryptedSecretsBlob {
                version: 2,
                kdf: "argon2id".to_string(),
                cipher: "aes-256-gcm".to_string(),
                salt: "test-salt".to_string(),
                nonce: "test-nonce".to_string(),
                ciphertext: "opaque-encrypted-payload".to_string(),
                payload_type: Some("dbx-sync-secrets".to_string()),
                aad: Some("test-context".to_string()),
            }),
            selection: Some(SyncSelection::default()),
        }
    }

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in entries {
            archive
                .start_file(*name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored))
                .unwrap();
            archive.write_all(contents).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    #[test]
    fn webdav_zip_round_trip_preserves_snapshot_metadata_and_encrypted_payload() {
        let snapshot = snapshot();
        for remote_path in ["DBX/sync/snapshot.zip", "DBX/sync/snapshot.ZIP"] {
            let (bytes, content_type) = encode(&snapshot, remote_path).unwrap();
            assert_eq!(content_type, "application/zip");
            assert!(bytes.starts_with(b"PK\x03\x04"));
            let mut archive = ZipArchive::new(Cursor::new(&bytes)).unwrap();
            assert_eq!(archive.len(), 1);
            let entry = archive.by_index(0).unwrap();
            assert_eq!(entry.name(), SNAPSHOT_ENTRY);
            assert_eq!(entry.compression(), CompressionMethod::Deflated);
            assert_eq!(
                serde_json::to_value(decode(&bytes).unwrap()).unwrap(),
                serde_json::to_value(&snapshot).unwrap()
            );
        }
    }

    #[test]
    fn webdav_non_zip_paths_keep_the_existing_json_payload() {
        let snapshot = snapshot();
        let expected = serde_json::to_vec_pretty(&snapshot).unwrap();
        for remote_path in ["DBX/sync/snapshot.json", "snapshot.backup", "zip", "folder.zip/snapshot"] {
            let (bytes, content_type) = encode(&snapshot, remote_path).unwrap();
            assert_eq!(content_type, "application/json");
            assert_eq!(bytes, expected);
            assert_eq!(
                serde_json::to_value(decode(&bytes).unwrap()).unwrap(),
                serde_json::to_value(&snapshot).unwrap()
            );
        }
    }

    #[test]
    fn webdav_zip_rejects_invalid_structure_and_json() {
        let json = serde_json::to_vec(&snapshot()).unwrap();
        for bytes in [
            b"PK-invalid-archive".to_vec(),
            archive(&[]),
            archive(&[("other.json", &json)]),
            archive(&[("../snapshot.json", &json)]),
            archive(&[("snapshot.json", &json), ("extra.json", &json)]),
            archive(&[("snapshot.json", b"not-json")]),
        ] {
            assert!(decode(&bytes).is_err());
        }
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive.add_symlink(SNAPSHOT_ENTRY, "target.json", SimpleFileOptions::default()).unwrap();
        assert!(decode(&archive.finish().unwrap().into_inner()).unwrap_err().contains("regular snapshot.json"));
    }

    #[test]
    fn webdav_zip_checks_uncompressed_size_and_checksum() {
        let json = serde_json::to_vec(&snapshot()).unwrap();
        let mut bytes = archive(&[(SNAPSHOT_ENTRY, &json)]);
        assert_eq!(decode_zip(&bytes, json.len() as u64 - 1).unwrap_err(), ZIP_SIZE_ERROR);
        assert!(decode_zip(&bytes, json.len() as u64).is_ok());
        let payload_offset = bytes.windows(json.len()).position(|window| window == json).unwrap();
        bytes[payload_offset + 2] ^= 1;
        assert!(decode(&bytes).unwrap_err().contains("Cannot read WebDAV ZIP snapshot"));
    }

    #[test]
    fn webdav_upload_errors_suggest_zip_without_hiding_failures() {
        for status in [StatusCode::FORBIDDEN, StatusCode::METHOD_NOT_ALLOWED, StatusCode::UNSUPPORTED_MEDIA_TYPE] {
            let json_error = upload_error(status, "application/json");
            assert!(json_error.starts_with(&format!("WebDAV upload failed with HTTP {status}")));
            assert!(json_error.contains("snapshot.zip"));
            let zip_error = upload_error(status, "application/zip");
            assert!(zip_error.contains("write permissions"));
            assert!(!zip_error.contains("snapshot.zip"));
        }
        assert_eq!(
            upload_error(StatusCode::UNAUTHORIZED, "application/json"),
            "WebDAV upload failed with HTTP 401 Unauthorized"
        );
    }

    struct CapturedRequest {
        headers: String,
        body: Vec<u8>,
    }

    async fn spawn_round_trip_server(
        request_count: usize,
        zip_only: bool,
        mut stored: Vec<u8>,
    ) -> (String, tokio::task::JoinHandle<Vec<CapturedRequest>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut captured = Vec::new();
            for _ in 0..request_count {
                let (mut socket, _) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept()).await.unwrap().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                let header_end = loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(offset) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break offset + 4;
                    }
                };
                let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while request.len() < header_end + content_length {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                let body = request[header_end..header_end + content_length].to_vec();
                let mut request_line = headers.lines().next().unwrap().split_whitespace();
                let method = request_line.next().unwrap();
                let target = request_line.next().unwrap();
                let (status, response_body) = match method {
                    "MKCOL" => ("201 Created", Vec::new()),
                    "PUT" if zip_only && !target.to_ascii_lowercase().ends_with(".zip") => {
                        ("405 Method Not Allowed", b"Only .zip/.prop uploads allowed".to_vec())
                    }
                    "PUT" => {
                        stored = body.clone();
                        ("201 Created", Vec::new())
                    }
                    "GET" => ("200 OK", stored.clone()),
                    _ => panic!("Unexpected method: {method}"),
                };
                captured.push(CapturedRequest { headers, body });
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            response_body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&response_body).await.unwrap();
            }
            captured
        });
        (format!("http://{address}/dav/"), server)
    }

    fn config(endpoint: String, remote_path: &str) -> WebDavConfig {
        WebDavConfig {
            endpoint,
            username: Some("test-user".to_string()),
            password: Some("test-password".to_string()),
            remote_path: Some(remote_path.to_string()),
            user_agent: Some("Zotero/10.0.0".to_string()),
        }
    }

    #[tokio::test]
    async fn webdav_zip_resolves_upload_rejection_and_round_trips_over_http() {
        use base64::Engine;

        let snapshot = snapshot();
        let (endpoint, server) = spawn_round_trip_server(7, true, Vec::new()).await;
        let json_client = WebDavClient::new(config(endpoint.clone(), "DBX/sync/snapshot.json"));
        let error = json_client.put_snapshot(&snapshot).await.unwrap_err();
        assert!(error.contains("405 Method Not Allowed"));
        assert!(error.contains("snapshot.zip"));
        let zip_client = WebDavClient::new(config(endpoint, "DBX/sync/snapshot.zip"));
        let uploaded = zip_client.put_snapshot(&snapshot).await.unwrap();
        let (restored, downloaded) = zip_client.get_snapshot().await.unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), serde_json::to_value(&snapshot).unwrap());
        assert_eq!(uploaded.bytes, downloaded.bytes);
        assert_eq!(uploaded.remote_path, "DBX/sync/snapshot.zip");
        assert_eq!(downloaded.app_version.as_deref(), Some("test-version"));
        let requests = server.await.unwrap();
        let authorization = format!(
            "authorization: Basic {}",
            base64::engine::general_purpose::STANDARD.encode("test-user:test-password")
        );
        for request in &requests {
            assert!(request.headers.lines().any(|line| line.eq_ignore_ascii_case("user-agent: Zotero/10.0.0")));
            assert!(request.headers.lines().any(|line| line.eq_ignore_ascii_case(&authorization)));
        }
        let json_upload = &requests[2];
        assert!(json_upload.headers.starts_with("PUT /dav/DBX/sync/snapshot.json "));
        assert!(json_upload.headers.to_ascii_lowercase().contains("content-type: application/json"));
        let zip_upload = &requests[5];
        assert!(zip_upload.headers.starts_with("PUT /dav/DBX/sync/snapshot.zip "));
        assert!(zip_upload.headers.to_ascii_lowercase().contains("content-type: application/zip"));
        assert_eq!(zip_upload.body.len(), uploaded.bytes);
        assert!(zip_upload.body.starts_with(b"PK\x03\x04"));
    }

    #[tokio::test]
    async fn webdav_json_upload_and_download_remain_unchanged() {
        let snapshot = snapshot();
        let (endpoint, server) = spawn_round_trip_server(2, false, Vec::new()).await;
        let mut config = config(endpoint, "snapshot.json");
        config.user_agent = None;
        let client = WebDavClient::new(config);
        let uploaded = client.put_snapshot(&snapshot).await.unwrap();
        let (restored, downloaded) = client.get_snapshot().await.unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), serde_json::to_value(&snapshot).unwrap());
        assert_eq!(uploaded.bytes, downloaded.bytes);
        let requests = server.await.unwrap();
        assert_eq!(requests[0].body, serde_json::to_vec_pretty(&snapshot).unwrap());
        assert!(requests.iter().all(|request| !request.headers.to_ascii_lowercase().contains("user-agent:")));
    }

    #[tokio::test]
    async fn webdav_download_detects_content_instead_of_trusting_the_path() {
        let snapshot = snapshot();
        for (remote_path, body) in [
            ("legacy.zip", serde_json::to_vec_pretty(&snapshot).unwrap()),
            ("snapshot.json", encode(&snapshot, "snapshot.zip").unwrap().0),
        ] {
            let (endpoint, server) = spawn_round_trip_server(1, false, body).await;
            let client = WebDavClient::new(config(endpoint, remote_path));
            let (restored, _) = client.get_snapshot().await.unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap(), serde_json::to_value(&snapshot).unwrap());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn webdav_zip_download_enforces_archive_size_without_limiting_legacy_json() {
        let snapshot = snapshot();
        let zip = encode(&snapshot, "snapshot.zip").unwrap().0;
        let zip_size = zip.len() as u64;
        let json = serde_json::to_vec(&snapshot).unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        for (body, limit, expected_success) in
            [(zip.clone(), zip_size - 1, false), (zip, zip_size, true), (json, 4, true)]
        {
            let (endpoint, server) = spawn_round_trip_server(1, false, body.clone()).await;
            let response = http.get(endpoint).send().await.unwrap();
            let result = read_response_with_limit(response, limit).await;
            if expected_success {
                assert_eq!(result.unwrap(), body);
            } else {
                assert_eq!(result.unwrap_err(), ZIP_SIZE_ERROR);
            }
            server.await.unwrap();
        }
    }
}
