use crate::models::connection::ProxyType;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct ProxyTunnelManager {
    tunnels: tokio::sync::Mutex<HashMap<String, (JoinHandle<()>, u16)>>,
}

impl ProxyTunnelManager {
    pub fn new() -> Self {
        Self { tunnels: tokio::sync::Mutex::new(HashMap::new()) }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_tunnel(
        &self,
        connection_id: &str,
        proxy_type: ProxyType,
        proxy_host: &str,
        proxy_port: u16,
        proxy_username: &str,
        proxy_password: &str,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, String> {
        if let Some(local_port) = self.local_port(connection_id).await {
            return Ok(local_port);
        }

        let local_port = portpicker::pick_unused_port().ok_or("No available port")?;
        let listener = TcpListener::bind(("127.0.0.1", local_port))
            .await
            .map_err(|e| format!("Failed to bind proxy tunnel local port: {e}"))?;

        let proxy = ProxyEndpoint {
            proxy_type,
            host: proxy_host.to_string(),
            port: proxy_port,
            username: proxy_username.to_string(),
            password: proxy_password.to_string(),
        };
        let remote = RemoteEndpoint { host: remote_host.to_string(), port: remote_port };
        let handle = tokio::spawn(proxy_forward_loop(listener, proxy, remote));

        let mut tunnels = self.tunnels.lock().await;
        if let Some((_, existing_port)) = tunnels.get(connection_id) {
            handle.abort();
            return Ok(*existing_port);
        }

        tunnels.insert(connection_id.to_string(), (handle, local_port));
        Ok(local_port)
    }

    pub async fn local_port(&self, connection_id: &str) -> Option<u16> {
        self.tunnels.lock().await.get(connection_id).map(|(_, port)| *port)
    }

    pub async fn stop_tunnel(&self, connection_id: &str) {
        if let Some((handle, _)) = self.tunnels.lock().await.remove(connection_id) {
            handle.abort();
        }
    }
}

#[derive(Clone)]
struct ProxyEndpoint {
    proxy_type: ProxyType,
    host: String,
    port: u16,
    username: String,
    password: String,
}

#[derive(Clone)]
struct RemoteEndpoint {
    host: String,
    port: u16,
}

async fn proxy_forward_loop(listener: TcpListener, proxy: ProxyEndpoint, remote: RemoteEndpoint) {
    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => break,
        };
        let proxy = proxy.clone();
        let remote = remote.clone();
        tokio::spawn(async move {
            let Ok(mut outbound) = connect_via_proxy(&proxy, &remote).await else {
                return;
            };
            let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
        });
    }
}

async fn connect_via_proxy(proxy: &ProxyEndpoint, remote: &RemoteEndpoint) -> Result<TcpStream, String> {
    let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect((proxy.host.as_str(), proxy.port)))
        .await
        .map_err(|_| "Proxy connection timed out".to_string())?
        .map_err(|e| format!("Failed to connect proxy: {e}"))?;

    match proxy.proxy_type {
        ProxyType::Http => http_connect(stream, proxy, remote).await,
        ProxyType::Socks5 => socks5_connect(stream, proxy, remote).await,
    }
}

async fn http_connect(
    mut stream: TcpStream,
    proxy: &ProxyEndpoint,
    remote: &RemoteEndpoint,
) -> Result<TcpStream, String> {
    let target = format!("{}:{}", remote.host, remote.port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if !proxy.username.is_empty() || !proxy.password.is_empty() {
        let token = BASE64.encode(format!("{}:{}", proxy.username, proxy.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.map_err(|e| format!("Failed to send CONNECT request: {e}"))?;

    let mut response = Vec::new();
    let mut buf = [0_u8; 1];
    while !response.ends_with(b"\r\n\r\n") && response.len() < 8192 {
        let n = stream.read(&mut buf).await.map_err(|e| format!("Failed to read CONNECT response: {e}"))?;
        if n == 0 {
            break;
        }
        response.push(buf[0]);
    }
    let text = String::from_utf8_lossy(&response);
    if text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200") {
        Ok(stream)
    } else {
        let status = text.lines().next().unwrap_or("invalid proxy response");
        Err(format!("HTTP proxy CONNECT failed: {status}"))
    }
}

async fn socks5_connect(
    mut stream: TcpStream,
    proxy: &ProxyEndpoint,
    remote: &RemoteEndpoint,
) -> Result<TcpStream, String> {
    let wants_auth = !proxy.username.is_empty() || !proxy.password.is_empty();
    let methods: &[u8] = if wants_auth { &[0x00, 0x02] } else { &[0x00] };
    let mut hello = vec![0x05, methods.len() as u8];
    hello.extend_from_slice(methods);
    stream.write_all(&hello).await.map_err(|e| format!("Failed to send SOCKS greeting: {e}"))?;

    let mut method = [0_u8; 2];
    stream.read_exact(&mut method).await.map_err(|e| format!("Failed to read SOCKS greeting: {e}"))?;
    if method[0] != 0x05 {
        return Err("Invalid SOCKS proxy version".to_string());
    }
    match method[1] {
        0x00 => {}
        0x02 => socks5_authenticate(&mut stream, proxy).await?,
        0xff => return Err("SOCKS proxy rejected supported authentication methods".to_string()),
        other => return Err(format!("SOCKS proxy selected unsupported auth method: {other}")),
    }

    let host = remote.host.as_bytes();
    if host.len() > u8::MAX as usize {
        return Err("Remote host is too long for SOCKS5 domain address".to_string());
    }
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host);
    req.extend_from_slice(&remote.port.to_be_bytes());
    stream.write_all(&req).await.map_err(|e| format!("Failed to send SOCKS connect request: {e}"))?;

    let mut head = [0_u8; 4];
    stream.read_exact(&mut head).await.map_err(|e| format!("Failed to read SOCKS connect response: {e}"))?;
    if head[0] != 0x05 {
        return Err("Invalid SOCKS connect response version".to_string());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS proxy connect failed with code {}", head[1]));
    }
    let addr_len = match head[3] {
        0x01 => 4,
        0x03 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len).await.map_err(|e| format!("Failed to read SOCKS bound address length: {e}"))?;
            len[0] as usize
        }
        0x04 => 16,
        other => return Err(format!("Unsupported SOCKS bound address type: {other}")),
    };
    let mut discard = vec![0_u8; addr_len + 2];
    stream.read_exact(&mut discard).await.map_err(|e| format!("Failed to read SOCKS bound address: {e}"))?;
    Ok(stream)
}

async fn socks5_authenticate(stream: &mut TcpStream, proxy: &ProxyEndpoint) -> Result<(), String> {
    let username = proxy.username.as_bytes();
    let password = proxy.password.as_bytes();
    if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
        return Err("SOCKS username or password is too long".to_string());
    }
    let mut req = vec![0x01, username.len() as u8];
    req.extend_from_slice(username);
    req.push(password.len() as u8);
    req.extend_from_slice(password);
    stream.write_all(&req).await.map_err(|e| format!("Failed to send SOCKS authentication: {e}"))?;

    let mut res = [0_u8; 2];
    stream.read_exact(&mut res).await.map_err(|e| format!("Failed to read SOCKS authentication response: {e}"))?;
    if res == [0x01, 0x00] {
        Ok(())
    } else {
        Err("SOCKS proxy authentication failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::ProxyTunnelManager;
    use crate::models::connection::ProxyType;

    #[tokio::test]
    async fn start_tunnel_reuses_existing_local_port() {
        let manager = ProxyTunnelManager::new();

        let first_port = manager
            .start_tunnel("connection", ProxyType::Http, "127.0.0.1", 8080, "", "", "db.internal", 5432)
            .await
            .expect("first proxy tunnel should start");
        let second_port = manager
            .start_tunnel("connection", ProxyType::Http, "127.0.0.1", 8081, "", "", "other-db.internal", 5433)
            .await
            .expect("existing proxy tunnel should be reused");

        assert_eq!(second_port, first_port);
        assert_eq!(manager.local_port("connection").await, Some(first_port));

        manager.stop_tunnel("connection").await;
    }
}
