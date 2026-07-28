use crate::models::connection::ProxyType;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HTTP_RESPONSE_SIZE: usize = 8192;
const MAX_HTTP_INTERIM_RESPONSES: usize = 5;

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

    pub async fn stop_tunnels_with_prefix(&self, connection_id_prefix: &str) {
        let mut tunnels = self.tunnels.lock().await;
        let keys: Vec<String> = tunnels.keys().filter(|key| key.starts_with(connection_id_prefix)).cloned().collect();
        for key in keys {
            if let Some((handle, _)) = tunnels.remove(&key) {
                handle.abort();
            }
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
    let request = build_http_connect_request(&remote.host, remote.port, &proxy.username, &proxy.password, false);
    stream.write_all(&request).await.map_err(|e| format!("Failed to send CONNECT request: {e}"))?;

    // Read exactly through the final header so tunneled bytes already queued
    // by the proxy remain available to the database protocol.
    let response = read_http_connect_response(&mut stream).await?;
    parse_http_connect_response(&response)?;
    Ok(stream)
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

    let req = build_socks5_connect_request(&remote.host, remote.port)
        .map_err(|_| "Remote host is too long for SOCKS5 domain address".to_string())?;
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

fn unbracket_host(host: &str) -> &str {
    host.strip_prefix('[').and_then(|inner| inner.strip_suffix(']')).unwrap_or(host)
}

fn format_http_authority(host: &str, port: u16) -> String {
    let host = unbracket_host(host);
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{host}]:{port}"),
        _ => format!("{host}:{port}"),
    }
}

fn build_http_connect_request(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    include_probe_headers: bool,
) -> Vec<u8> {
    let target = format_http_authority(host, port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if include_probe_headers {
        request.push_str("User-Agent: Mozilla/5.0\r\nProxy-Connection: Keep-Alive\r\n");
    }
    if !username.is_empty() || !password.is_empty() {
        let token = BASE64.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    request.into_bytes()
}

fn build_socks5_connect_request(host: &str, port: u16) -> Result<Vec<u8>, ()> {
    let host = unbracket_host(host);
    let mut request = vec![0x05, 0x01, 0x00];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(0x01);
            request.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(0x04);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            let host = host.as_bytes();
            if host.len() > u8::MAX as usize {
                return Err(());
            }
            request.extend_from_slice(&[0x03, host.len() as u8]);
            request.extend_from_slice(host);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    Ok(request)
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

// ---------------------------------------------------------------------------
// Retry helpers for proxy endpoint testing
// ---------------------------------------------------------------------------
// These wrap tokio read/write with ENOTCONN/WouldBlock retry logic,
// which is needed on macOS where async connect can resolve before the
// TCP handshake is fully complete.

async fn write_all_retry(stream: &mut TcpStream, data: &[u8]) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    loop {
        match stream.write_all(data).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotConnected || e.kind() == std::io::ErrorKind::WouldBlock => {
                stream.writable().await.map_err(|e| format!("writable wait failed: {e}"))?;
            }
            Err(e) => return Err(format!("write failed: {e}")),
        }
    }
}

async fn read_with_retry(stream: &mut TcpStream, buf: &mut [u8]) -> Result<usize, String> {
    use tokio::io::AsyncReadExt;
    loop {
        match stream.read(buf).await {
            Ok(n) => return Ok(n),
            Err(e) if e.kind() == std::io::ErrorKind::NotConnected || e.kind() == std::io::ErrorKind::WouldBlock => {
                stream.readable().await.map_err(|e| format!("readable wait failed: {e}"))?;
            }
            Err(e) => return Err(format!("read failed: {e}")),
        }
    }
}

async fn read_exact_with_retry(stream: &mut TcpStream, buf: &mut [u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < buf.len() {
        let n = read_with_retry(stream, &mut buf[offset..]).await?;
        if n == 0 {
            return Err("connection closed".to_string());
        }
        offset += n;
    }
    Ok(())
}

fn find_http_header_end(response: &[u8]) -> Option<usize> {
    let crlf_end = response.windows(4).position(|window| window == b"\r\n\r\n").map(|pos| pos + 4);
    let lf_end = response.windows(2).position(|window| window == b"\n\n").map(|pos| pos + 2);
    match (crlf_end, lf_end) {
        (Some(crlf), Some(lf)) => Some(crlf.min(lf)),
        (Some(end), None) | (None, Some(end)) => Some(end),
        (None, None) => None,
    }
}

fn parse_http_status_code(header: &[u8]) -> Result<u16, String> {
    let text = String::from_utf8_lossy(header);
    let first_line = text.lines().next().unwrap_or("");
    let mut parts = first_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let status = parts.next().unwrap_or("");
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return Err(format!("HTTP proxy CONNECT failed: {first_line}"));
    }
    status.parse::<u16>().map_err(|_| format!("HTTP proxy CONNECT failed: {first_line}"))
}

async fn read_http_connect_response(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut response = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    let mut interim_responses = 0;

    loop {
        if let Some(end) = find_http_header_end(&response) {
            let status = parse_http_status_code(&response[..end])?;
            if (100..200).contains(&status) {
                interim_responses += 1;
                if interim_responses > MAX_HTTP_INTERIM_RESPONSES {
                    return Err("Proxy response is incomplete or malformed".to_string());
                }
                response.clear();
                continue;
            }
            response.truncate(end);
            return Ok(response);
        }
        if response.len() >= MAX_HTTP_RESPONSE_SIZE {
            return Err("Proxy response is incomplete or malformed".to_string());
        }

        let n = stream.read(&mut byte).await.map_err(|e| format!("Failed to read CONNECT response: {e}"))?;
        if n == 0 {
            return Ok(response);
        }
        response.push(byte[0]);
    }
}

async fn read_http_response_with_retry(stream: &mut TcpStream, max_size: usize) -> Result<Vec<u8>, String> {
    let mut response = Vec::with_capacity(max_size.min(4096));
    let mut buf = [0u8; 4096];
    let mut interim_responses = 0;

    loop {
        if let Some(end) = find_http_header_end(&response) {
            let status = parse_http_status_code(&response[..end])?;
            if (100..200).contains(&status) {
                interim_responses += 1;
                if interim_responses > MAX_HTTP_INTERIM_RESPONSES {
                    return Err("Proxy response is incomplete or malformed".to_string());
                }
                response.drain(..end);
                continue;
            }
            // A proxy can start the tunneled protocol in the same TCP read.
            // Only the final HTTP header belongs to the CONNECT handshake.
            response.truncate(end);
            return Ok(response);
        }
        if response.len() >= max_size {
            return Ok(response);
        }

        let remaining = max_size - response.len();
        let to_read = buf.len().min(remaining);
        let n = read_with_retry(stream, &mut buf[..to_read]).await?;
        if n == 0 {
            return Ok(response);
        }
        response.extend_from_slice(&buf[..n]);
    }
}

// ---------------------------------------------------------------------------
// Parse helpers for HTTP CONNECT and SOCKS5 CONNECT responses.
// These are pure functions (no I/O), testable without a running proxy.
// ---------------------------------------------------------------------------

/// Parse an HTTP CONNECT response, validating HTTP version and 2xx status.
///
/// Rejects truncated responses, handles interim 1xx responses by parsing the
/// final response, tolerates LF-only line endings, and ignores tunneled bytes
/// that follow the final header in the same read.
fn parse_http_connect_response(response: &[u8]) -> Result<String, String> {
    let mut remaining = response;
    let mut interim_responses = 0;
    loop {
        let Some(end) = find_http_header_end(remaining) else {
            return Err("Proxy response is incomplete or malformed".to_string());
        };
        if end > MAX_HTTP_RESPONSE_SIZE {
            return Err("Proxy response is incomplete or malformed".to_string());
        }
        let code = parse_http_status_code(&remaining[..end])?;
        if (100..200).contains(&code) {
            interim_responses += 1;
            if interim_responses > MAX_HTTP_INTERIM_RESPONSES {
                return Err("Proxy response is incomplete or malformed".to_string());
            }
            remaining = &remaining[end..];
            continue;
        }
        if (200..300).contains(&code) {
            return Ok(format!("HTTP CONNECT proxy connection successful ({code})"));
        }
        return Err(format!("HTTP proxy CONNECT failed: HTTP {code}"));
    }
}

/// Validate a SOCKS5 CONNECT reply header (first 4 bytes).
fn parse_socks5_connect_header(header: &[u8; 4]) -> Result<(), String> {
    if header[0] != 0x05 {
        return Err(format!("Invalid SOCKS proxy version: {}", header[0]));
    }
    if header[1] != 0x00 {
        return Err(format!("SOCKS proxy connect rejected (code {})", header[1]));
    }
    Ok(())
}

/// Parse a `test_target` string (`host:port` or `[ipv6]:port`) into `(String, u16)`.
fn parse_test_target(target: &str) -> Result<(String, u16), String> {
    // IPv6: [fe80::1]:7890 -> split on ']:', strip brackets
    if let Some(rest) = target.strip_prefix('[') {
        let Some((inner, port_str)) = rest.split_once("]:") else {
            return Err("Invalid test target, expected host:port or [ipv6]:port".to_string());
        };
        let port: u16 = port_str.parse().map_err(|_| "Invalid test target port".to_string())?;
        Ok((inner.to_string(), port))
    } else {
        let (host_str, port_str) = target
            .split_once(':')
            .ok_or_else(|| "Invalid test target, expected host:port or [ipv6]:port".to_string())?;
        if host_str.is_empty() || port_str.is_empty() {
            return Err("Invalid test target, expected host:port or [ipv6]:port".to_string());
        }
        let port: u16 = port_str.parse().map_err(|_| "Invalid test target port".to_string())?;
        Ok((host_str.to_string(), port))
    }
}

/// Test a proxy endpoint by performing a full HTTP CONNECT or SOCKS5
/// handshake.  When `test_target` is `Some(host:port)` the probe connects
/// to that target (full tunnel test).  When `None` the probe performs an
/// endpoint-only liveness check that exercises auth but requires no
/// external destination.
pub async fn test_proxy_endpoint(
    proxy_type: ProxyType,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    test_target: Option<&str>,
) -> Result<String, String> {
    let start = Instant::now();

    // Strip brackets if user typed IPv6 as [fe80::1]
    let host = host.trim_start_matches('[').trim_end_matches(']');

    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("Proxy connection timed out ({:?})", CONNECT_TIMEOUT))?
        .map_err(|e| format!("Failed to connect to proxy: {e}"))?;

    let handshake_result = timeout(CONNECT_TIMEOUT, async {
        match proxy_type {
            ProxyType::Http => {
                let connect_target = match test_target.filter(|t| !t.is_empty()) {
                    Some(target) => {
                        let (th, tp) = parse_test_target(target)?;
                        (th, tp)
                    }
                    None => {
                        // Endpoint-only: TCP reachability already verified above.
                        // No CONNECT is sent — this avoids destination/ACL
                        // dependency per RFC 9110 §9.3.6.
                        let elapsed = start.elapsed();
                        return Ok(format!("Proxy reachable on {host}:{port} — endpoint check only ({elapsed:?})"));
                    }
                };

                let (target_host, target_port) = connect_target;
                let target_authority = format_http_authority(&target_host, target_port);
                let request = build_http_connect_request(&target_host, target_port, username, password, true);

                write_all_retry(&mut stream, &request).await?;

                let response = read_http_response_with_retry(&mut stream, 8192).await?;
                let msg = parse_http_connect_response(&response)?;
                let elapsed = start.elapsed();
                Ok(format!("{msg} — {target_authority} ({elapsed:?})"))
            }
            ProxyType::Socks5 => {
                let wants_auth = !username.is_empty() || !password.is_empty();
                let methods: &[u8] = if wants_auth { &[0x00, 0x02] } else { &[0x00] };
                let mut hello = vec![0x05, methods.len() as u8];
                hello.extend_from_slice(methods);

                write_all_retry(&mut stream, &hello).await?;

                let mut method = [0u8; 2];
                read_exact_with_retry(&mut stream, &mut method).await?;
                if method[0] != 0x05 {
                    return Err(format!("Invalid SOCKS proxy version: {}", method[0]));
                }
                let mut auth_succeeded = false;
                match method[1] {
                    0x00 => {}
                    0x02 => {
                        let u = username.as_bytes();
                        let p = password.as_bytes();
                        if u.len() > u8::MAX as usize || p.len() > u8::MAX as usize {
                            return Err("SOCKS username or password is too long".to_string());
                        }
                        let mut req = vec![0x01, u.len() as u8];
                        req.extend_from_slice(u);
                        req.push(p.len() as u8);
                        req.extend_from_slice(p);
                        write_all_retry(&mut stream, &req).await?;
                        let mut res = [0u8; 2];
                        read_exact_with_retry(&mut stream, &mut res).await?;
                        if res != [0x01, 0x00] {
                            return Err("SOCKS proxy authentication failed".to_string());
                        }
                        auth_succeeded = true;
                    }
                    0xff => return Err("SOCKS proxy rejected all supported auth methods".to_string()),
                    other => return Err(format!("SOCKS proxy selected unsupported auth method: {other}")),
                }

                // CONNECT (full tunnel test) only when test_target is provided.
                // Otherwise the method/auth negotiation above is sufficient
                // for an endpoint-only reachability check.
                if let Some(target) = test_target.filter(|t| !t.is_empty()) {
                    let (target_host, target_port) = parse_test_target(target)?;
                    let req = build_socks5_connect_request(&target_host, target_port)
                        .map_err(|_| "Proxy target host too long for SOCKS5 domain address".to_string())?;
                    write_all_retry(&mut stream, &req).await?;

                    let mut head = [0u8; 4];
                    read_exact_with_retry(&mut stream, &mut head).await?;
                    parse_socks5_connect_header(&head)?;

                    // Discard remaining bound address bytes
                    let addr_len = match head[3] {
                        0x01 => 4,
                        0x03 => {
                            let mut len = [0u8; 1];
                            read_exact_with_retry(&mut stream, &mut len).await?;
                            len[0] as usize
                        }
                        0x04 => 16,
                        other => return Err(format!("Unsupported SOCKS bound address type: {other}")),
                    };
                    let mut discard = vec![0u8; addr_len + 2];
                    read_exact_with_retry(&mut stream, &mut discard).await?;

                    let elapsed = start.elapsed();
                    Ok(format!("SOCKS5 proxy connection successful — {target_host}:{target_port} ({elapsed:?})"))
                } else {
                    // Endpoint-only: auth verified, no CONNECT sent.
                    let auth_note = if auth_succeeded { " — auth verified" } else { "" };
                    let elapsed = start.elapsed();
                    Ok(format!("SOCKS5 proxy reachable on {host}:{port}{auth_note} ({elapsed:?})"))
                }
            }
        }
    })
    .await;

    match handshake_result {
        Ok(Ok(msg)) => Ok(msg),
        Ok(Err(e)) => Err(format!("Proxy handshake failed ({:?}): {e}", start.elapsed())),
        Err(_) => Err(format!("Proxy handshake timed out ({:?})", CONNECT_TIMEOUT)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::ProxyType;

    // ── HTTP CONNECT response parsing ──────────────────────────────────────

    #[test]
    fn parse_http_success_http11() {
        let resp = parse_http_connect_response(b"HTTP/1.1 200 Connection Established\r\n\r\n");
        assert!(resp.is_ok(), "HTTP/1.1 200 should be success, got: {resp:?}");
        assert!(resp.unwrap().contains("200"));
    }

    #[test]
    fn parse_http_success_http10() {
        let resp = parse_http_connect_response(b"HTTP/1.0 200 OK\r\n\r\n");
        assert!(resp.is_ok(), "HTTP/1.0 200 should be success, got: {resp:?}");
    }

    #[test]
    fn parse_http_error_status() {
        let resp = parse_http_connect_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n");
        assert!(resp.is_err(), "502 should be error");
        assert!(resp.unwrap_err().contains("502"), "error should mention 502");
    }

    #[test]
    fn parse_http_malformed_garbage() {
        // No HTTP status line and missing terminator — rejected as incomplete.
        let resp = parse_http_connect_response(b"garbage response line");
        assert!(resp.is_err(), "garbage should be error");
        assert!(resp.unwrap_err().contains("incomplete"), "should mention incomplete");
    }

    #[test]
    fn parse_http_empty_response() {
        let resp = parse_http_connect_response(b"");
        assert!(resp.is_err(), "empty should be error");
    }

    #[test]
    fn parse_http_bad_version() {
        let resp = parse_http_connect_response(b"HTTP/2.0 200 OK\r\n\r\n");
        assert!(resp.is_err(), "HTTP/2.0 should be rejected");
    }

    #[test]
    fn parse_http_bad_version_malformed_digit() {
        // HTTP-version = HTTP-name "/" DIGIT "." DIGIT  (RFC 9112 §3.2)
        let resp = parse_http_connect_response(b"HTTP/1.x 200 OK\r\n\r\n");
        assert!(resp.is_err(), "HTTP/1.x should be rejected");
    }

    #[test]
    fn parse_http_truncated_missing_terminator() {
        // Response without \r\n\r\n terminator — truncated/malformed.
        let resp = parse_http_connect_response(b"HTTP/1.1 200 OK");
        assert!(resp.is_err(), "truncated should be error");
        assert!(resp.unwrap_err().contains("incomplete"), "should mention incomplete");
    }

    #[test]
    fn parse_http_truncated_lf_only() {
        // LF-only line ending without double-\n terminator.
        let resp = parse_http_connect_response(b"HTTP/1.1 200 OK\n");
        assert!(resp.is_err(), "truncated LF-only should be error");
    }

    #[test]
    fn parse_http_continue_then_success() {
        // 100 Continue followed by the real 200 response.
        let resp =
            parse_http_connect_response(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 Connection Established\r\n\r\n");
        assert!(resp.is_ok(), "100 Continue + 200 should be success, got: {resp:?}");
        assert!(resp.unwrap().contains("200"));
    }

    #[test]
    fn parse_http_continue_with_headers_then_success() {
        // 100 Continue with extra headers followed by 200.
        let resp =
            parse_http_connect_response(b"HTTP/1.1 100 Continue\r\nServer: Proxy\r\n\r\nHTTP/1.1 200 OK\r\n\r\n");
        assert!(resp.is_ok(), "100 Continue with headers + 200 should be success");
    }

    #[test]
    fn parse_http_continue_only() {
        // Just 100 Continue and nothing else — incomplete.
        let resp = parse_http_connect_response(b"HTTP/1.1 100 Continue\r\n\r\n");
        assert!(resp.is_err(), "100 Continue alone should be error");
    }

    #[test]
    fn parse_http_auth_challenge_407() {
        // 407 Proxy Authentication Required.
        let resp =
            parse_http_connect_response(b"HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic\r\n\r\n");
        assert!(resp.is_err(), "407 should be error");
        assert!(resp.unwrap_err().contains("407"), "error should mention 407");
    }

    #[test]
    fn parse_http_oversized_response() {
        // Response exceeding 8192 bytes.
        let mut oversized = b"HTTP/1.1 200 OK\r\n".to_vec();
        oversized.resize(8193, b'X');
        let resp = parse_http_connect_response(&oversized);
        assert!(resp.is_err(), "oversized should be error");
        assert!(resp.unwrap_err().contains("incomplete"), "should mention incomplete");
    }

    #[test]
    fn parse_http_lf_only_terminator() {
        // LF-only line endings with \n\n terminator (RFC 7230 §3.5 tolerance).
        let resp = parse_http_connect_response(b"HTTP/1.1 200 OK\n\n");
        assert!(resp.is_ok(), "LF-only with double-LF terminator should be success");
    }

    #[test]
    fn parse_http_success_ignores_immediate_tunneled_payload() {
        let resp = parse_http_connect_response(b"HTTP/1.1 200 OK\r\n\r\n\x16\x03\x01\x00\x2a");
        assert!(resp.is_ok(), "binary payload after final header should be ignored");
    }

    #[test]
    fn http_request_preserves_hostname_ipv4_and_ipv6() {
        assert_eq!(
            build_http_connect_request("db.example.com", 5432, "", "", false),
            b"CONNECT db.example.com:5432 HTTP/1.1\r\nHost: db.example.com:5432\r\n\r\n"
        );
        assert_eq!(
            build_http_connect_request("192.0.2.10", 5432, "", "", false),
            b"CONNECT 192.0.2.10:5432 HTTP/1.1\r\nHost: 192.0.2.10:5432\r\n\r\n"
        );
        assert_eq!(
            build_http_connect_request("2001:db8::10", 5432, "", "", false),
            b"CONNECT [2001:db8::10]:5432 HTTP/1.1\r\nHost: [2001:db8::10]:5432\r\n\r\n"
        );
        assert_eq!(
            build_http_connect_request("[2001:db8::10]", 5432, "", "", false),
            b"CONNECT [2001:db8::10]:5432 HTTP/1.1\r\nHost: [2001:db8::10]:5432\r\n\r\n"
        );
    }

    #[test]
    fn socks5_request_preserves_hostname_ipv4_and_ipv6() {
        assert_eq!(
            build_socks5_connect_request("db.example.com", 5432).unwrap(),
            [vec![0x05, 0x01, 0x00, 0x03, 14], b"db.example.com".to_vec(), 5432_u16.to_be_bytes().to_vec(),].concat()
        );
        assert_eq!(
            build_socks5_connect_request("192.0.2.10", 5432).unwrap(),
            vec![0x05, 0x01, 0x00, 0x01, 192, 0, 2, 10, 0x15, 0x38]
        );
        assert_eq!(
            build_socks5_connect_request("2001:db8::10", 5432).unwrap(),
            vec![
                0x05, 0x01, 0x00, 0x04, 0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x10, 0x15, 0x38,
            ]
        );
    }

    #[tokio::test]
    async fn runtime_http_connect_preserves_same_read_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let payload = b"\x16\x03\x01\x00\x2a";

        let mock = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0_u8; 256];
            while find_http_header_end(&request).is_none() {
                let n = connection.read(&mut buf).await.unwrap();
                assert_ne!(n, 0, "CONNECT request should be complete");
                request.extend_from_slice(&buf[..n]);
            }
            assert!(request.starts_with(b"CONNECT db.example.com:5432 HTTP/1.1\r\nHost: db.example.com:5432\r\n"));
            connection.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n\x16\x03\x01\x00\x2a").await.unwrap();
        });

        let stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        let proxy = ProxyEndpoint {
            proxy_type: ProxyType::Http,
            host: "127.0.0.1".to_string(),
            port: proxy_port,
            username: String::new(),
            password: String::new(),
        };
        let remote = RemoteEndpoint { host: "db.example.com".to_string(), port: 5432 };
        let mut tunneled = http_connect(stream, &proxy, &remote).await.unwrap();
        let mut actual_payload = [0_u8; 5];
        tunneled.read_exact(&mut actual_payload).await.unwrap();

        mock.await.unwrap();
        assert_eq!(&actual_payload, payload);
    }

    // ── test_target parsing ───────────────────────────────────────────────

    #[test]
    fn parse_test_target_ipv4() {
        let (host, port) = parse_test_target("192.168.1.1:8080").unwrap();
        assert_eq!(host, "192.168.1.1");
        assert_eq!(port, 8080);
    }

    #[test]
    fn parse_test_target_ipv6() {
        let (host, port) = parse_test_target("[fe80::1]:7890").unwrap();
        assert_eq!(host, "fe80::1");
        assert_eq!(port, 7890);
    }

    #[test]
    fn parse_test_target_hostname() {
        let (host, port) = parse_test_target("proxy.example.com:3128").unwrap();
        assert_eq!(host, "proxy.example.com");
        assert_eq!(port, 3128);
    }

    #[test]
    fn parse_test_target_missing_port() {
        let err = parse_test_target("192.168.1.1").unwrap_err();
        assert!(err.contains("Invalid test target"), "should mention invalid");
    }

    #[test]
    fn parse_test_target_empty_host() {
        let err = parse_test_target(":8080").unwrap_err();
        assert!(err.contains("Invalid test target"), "should mention invalid");
    }

    #[test]
    fn parse_test_target_bad_port() {
        let err = parse_test_target("host:badport").unwrap_err();
        assert!(err.contains("port"), "should mention port");
    }

    #[test]
    fn parse_test_target_bad_ipv6_missing_bracket() {
        let err = parse_test_target("[fe80::1:7890").unwrap_err();
        assert!(err.contains("Invalid test target"), "malformed IPv6 should fail");
    }

    // ── SOCKS5 CONNECT header parsing ─────────────────────────────────────

    #[test]
    fn parse_socks5_header_success() {
        let result = parse_socks5_connect_header(&[0x05, 0x00, 0x00, 0x01]);
        assert!(result.is_ok(), "0x00 reply should be success");
    }

    #[test]
    fn parse_socks5_header_rejected() {
        let result = parse_socks5_connect_header(&[0x05, 0x03, 0x00, 0x01]);
        assert!(result.is_err(), "code 0x03 should be error");
        assert!(result.unwrap_err().contains("rejected"), "error should mention rejected");
    }

    #[test]
    fn parse_socks5_header_bad_version() {
        let result = parse_socks5_connect_header(&[0x04, 0x00, 0x00, 0x01]);
        assert!(result.is_err(), "version 4 should be error");
        assert!(result.unwrap_err().contains("version"), "error should mention version");
    }

    // ── Existing tunnel lifecycle tests ────────────────────────────────────

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

    // ── I/O-layer 1xx response handling ────────────────────────────────────

    #[tokio::test]
    async fn read_http_1xx_then_final_in_separate_writes() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let port = addr.port();

        // Mock proxy: sends 100 Continue and 200 OK in separate writes
        let mock = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            // Consume the CONNECT request
            let mut buf = [0u8; 4096];
            loop {
                let n = conn.read(&mut buf).await.unwrap();
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == 0 {
                    break;
                }
            }
            // Write 100 Continue
            conn.write_all(b"HTTP/1.1 100 Continue\r\nServer: test\r\n\r\n").await.unwrap();
            // Small delay to encourage separate TCP segments
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            // Write 200 OK
            conn.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
            // Hold connection open until the test finishes
            let _ = tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        });

        let result = test_proxy_endpoint(ProxyType::Http, "127.0.0.1", port, "", "", Some("example.com:443")).await;

        mock.await.unwrap();
        assert!(result.is_ok(), "should succeed with 100+200 in separate writes, got: {result:?}");
        assert!(result.unwrap().contains("example.com:443"), "should mention test target");
    }

    #[tokio::test]
    async fn read_http_1xx_then_final_in_same_write() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // Mock proxy: sends 100 Continue + 200 OK in a single write
        let mock = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            loop {
                let n = conn.read(&mut buf).await.unwrap();
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == 0 {
                    break;
                }
            }
            conn.write_all(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 Connection Established\r\n\r\n\x16\x03\x01")
                .await
                .unwrap();
            let _ = tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        });

        let result = test_proxy_endpoint(ProxyType::Http, "127.0.0.1", port, "", "", Some("example.com:443")).await;

        mock.await.unwrap();
        assert!(result.is_ok(), "should succeed with 100+200 in same write, got: {result:?}");
        assert!(result.unwrap().contains("200"), "should mention 200 status");
    }

    #[tokio::test]
    async fn read_http_lf_only_response_with_connection_held_open() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // Mock proxy: LF-only 200 OK, connection stays open (no immediate close)
        let mock = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            loop {
                let n = conn.read(&mut buf).await.unwrap();
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == 0 {
                    break;
                }
            }
            conn.write_all(b"HTTP/1.1 200 OK\n\n").await.unwrap();
            // Connection stays open — the reader must detect \n\n and not time out
            let _ = tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        });

        let result = test_proxy_endpoint(ProxyType::Http, "127.0.0.1", port, "", "", Some("example.com:443")).await;

        mock.await.unwrap();
        assert!(result.is_ok(), "LF-only 200 should succeed, got: {result:?}");
    }

    #[tokio::test]
    async fn socks5_endpoint_check_no_auth_claimed_when_server_selects_method_zero() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // SOCKS5 server that selects method 0x00 (no auth) despite credentials offered
        let mock = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 256];
            let n = conn.read(&mut buf).await.unwrap();
            assert!(buf[..n].contains(&0x02), "should offer username/password method");
            // Select method 0x00 — no authentication
            conn.write_all(&[0x05, 0x00]).await.unwrap();
            let _ = tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        });

        let result = test_proxy_endpoint(ProxyType::Socks5, "127.0.0.1", port, "user", "pass", None).await;

        mock.await.unwrap();
        assert!(result.is_ok(), "should reach proxy, got: {result:?}");
        assert!(
            !result.unwrap().contains("auth verified"),
            "should NOT claim auth verified when server selected method 0x00"
        );
    }
}
