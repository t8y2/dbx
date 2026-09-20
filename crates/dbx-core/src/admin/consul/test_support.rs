use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::{ConsulClient, ConsulConfig, ConsulConsistency};

pub(super) async fn serve_once(response: String) -> (reqwest::Url, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, request_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = find_bytes(&request, b"\r\n\r\n") else {
                assert!(request.len() <= 1024 * 1024);
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        let _ = request_tx.send(String::from_utf8(request).unwrap());
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    (reqwest::Url::parse(&format!("http://{address}/proxy")).unwrap(), request_rx)
}

pub(super) async fn test_client(base_url: reqwest::Url) -> ConsulClient {
    ConsulClient::new(ConsulConfig {
        base_url,
        token: "fixture-token".to_string(),
        datacenter: "dc1".to_string(),
        namespace: "team-a".to_string(),
        partition: "partition-a".to_string(),
        consistency: ConsulConsistency::Consistent,
        tls_skip_verify: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        connect_timeout_secs: 5,
        request_timeout_secs: 5,
        connect_override: None,
        operator_snapshot_restore_enabled: false,
        operator_autopilot_write_enabled: false,
        operator_raft_write_enabled: false,
        operator_keyring_write_enabled: false,
        operator_license_write_enabled: false,
        agent_target: None,
    })
    .await
    .unwrap()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}
