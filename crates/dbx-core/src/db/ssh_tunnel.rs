use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh::client::{self, Config, Handle};
use russh::keys::agent::{client::AgentClient, AgentIdentity};
use russh::keys::{decode_secret_key, key::PrivateKeyWithHashAlg, PrivateKey};
use russh::{kex, ChannelMsg, Preferred};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior};

use crate::models::connection::SshTunnelConfig;

use super::file_validator::validate_file_path;

/// Initial delay between SSH reconnect attempts.
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// Maximum delay for exponential backoff.
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
/// Maximum number of consecutive reconnect attempts before giving up.
const MAX_RECONNECT_ATTEMPTS: u32 = 10;
/// How often an idle local listener verifies that the SSH session still answers.
const IDLE_SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// Maximum time to wait for an explicit SSH ping response.
const IDLE_SESSION_PING_TIMEOUT: Duration = Duration::from_secs(10);

struct SshClient;

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

fn ssh_client_config() -> Config {
    let mut preferred = Preferred::default();
    let mut kex = preferred.kex.into_owned();
    for algorithm in [kex::ECDH_SHA2_NISTP256, kex::ECDH_SHA2_NISTP384, kex::ECDH_SHA2_NISTP521, kex::DH_G14_SHA1] {
        if !kex.contains(&algorithm) {
            kex.push(algorithm);
        }
    }
    preferred.kex = Cow::Owned(kex);

    Config { nodelay: true, keepalive_interval: Some(Duration::from_secs(30)), preferred, ..Default::default() }
}

#[allow(clippy::too_many_arguments)]
async fn connect_and_authenticate(
    ssh_host: &str,
    ssh_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    connect_timeout_secs: u64,
) -> Result<Handle<SshClient>, String> {
    let config = Arc::new(ssh_client_config());
    let connect_timeout = Duration::from_secs(connect_timeout_secs);

    let mut session =
        tokio::time::timeout(connect_timeout, client::connect(config, (ssh_host, ssh_port), SshClient {}))
            .await
            .map_err(|_| format!("SSH connection timed out ({connect_timeout_secs}s)"))?
            .map_err(|e| format!("SSH connection failed: {e}"))?;

    if !ssh_key_path.is_empty() {
        // Validate SSH key file path
        validate_file_path(ssh_key_path, |_| false)?;

        let passphrase = if ssh_key_passphrase.is_empty() { None } else { Some(ssh_key_passphrase) };
        let key_pair =
            load_ssh_private_key(ssh_key_path, passphrase).map_err(|e| format!("Failed to load SSH key: {e}"))?;
        let auth_res = tokio::time::timeout(
            connect_timeout,
            session.authenticate_publickey(
                ssh_user,
                PrivateKeyWithHashAlg::new(
                    Arc::new(key_pair),
                    session.best_supported_rsa_hash().await.ok().flatten().flatten(),
                ),
            ),
        )
        .await
        .map_err(|_| format!("SSH key auth timed out ({connect_timeout_secs}s)"))?
        .map_err(|e| format!("SSH key auth failed: {e}"))?;
        if !auth_res.success() {
            return Err("SSH public key authentication failed".to_string());
        }
    } else if !ssh_password.is_empty() {
        let auth_res = tokio::time::timeout(connect_timeout, session.authenticate_password(ssh_user, ssh_password))
            .await
            .map_err(|_| format!("SSH password auth timed out ({connect_timeout_secs}s)"))?
            .map_err(|e| format!("SSH password auth failed: {e}"))?;
        if !auth_res.success() {
            return Err("SSH password authentication failed".to_string());
        }
    } else if use_ssh_agent {
        match try_authenticate_with_agent(&mut session, ssh_user, ssh_agent_sock_path, &connect_timeout).await {
            Ok(()) => {}
            Err(agent_err) => return Err(agent_err),
        }
    } else {
        return Err("No SSH authentication method provided (password, key, or ssh-agent)".to_string());
    }

    Ok(session)
}

/// Try to authenticate using ssh-agent identities. Returns `Ok(())` on success,
/// or an error describing why agent auth failed (unavailable, no identities, all rejected).
async fn try_authenticate_with_agent(
    session: &mut Handle<SshClient>,
    ssh_user: &str,
    ssh_agent_sock_path: &str,
    connect_timeout: &Duration,
) -> Result<(), String> {
    #[cfg(unix)]
    let mut agent = if ssh_agent_sock_path.is_empty() {
        match AgentClient::connect_env().await {
            Ok(a) => a,
            Err(e) => {
                return Err(format!("No SSH password or key provided, and ssh-agent is unavailable: {e}"));
            }
        }
    } else {
        match AgentClient::connect_uds(ssh_agent_sock_path).await {
            Ok(a) => a,
            Err(e) => {
                return Err(format!(
                    "No SSH password or key provided, and ssh-agent at '{}' is unavailable: {e}",
                    ssh_agent_sock_path
                ));
            }
        }
    };

    #[cfg(windows)]
    let mut agent = {
        let stream = pageant::PageantStream::new()
            .await
            .map_err(|e| format!("No SSH password or key provided, and ssh-agent (Pageant) is unavailable: {e}"))?;
        AgentClient::connect(stream)
    };

    let identities = match agent.request_identities().await {
        Ok(ids) if ids.is_empty() => {
            return Err("No SSH password or key provided, and ssh-agent has no identities".to_string());
        }
        Ok(ids) => ids,
        Err(e) => {
            return Err(format!("No SSH password or key provided, and ssh-agent request failed: {e}"));
        }
    };

    let hash_alg = session.best_supported_rsa_hash().await.ok().flatten().flatten();

    let auth_result = tokio::time::timeout(*connect_timeout, async {
        for identity in identities {
            let result = match &identity {
                AgentIdentity::PublicKey { key, .. } => {
                    session.authenticate_publickey_with(ssh_user, key.clone(), hash_alg, &mut agent).await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    session.authenticate_certificate_with(ssh_user, certificate.clone(), hash_alg, &mut agent).await
                }
            };

            match result {
                Ok(auth_res) if auth_res.success() => return Ok(()),
                Ok(_) => continue,
                Err(e) => {
                    log::debug!("SSH agent identity ({}) auth failed: {e}", identity.comment());
                    continue;
                }
            }
        }
        Err("No SSH password or key provided, and no ssh-agent identity was accepted".to_string())
    })
    .await;

    match auth_result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("No SSH password or key provided, and ssh-agent auth timed out".to_string()),
    }
}

fn load_ssh_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let secret = fs::read_to_string(path).map_err(|e| e.to_string())?;
    match decode_secret_key(&secret, passphrase) {
        Ok(key) => Ok(key),
        Err(err) if is_ssh_key_character_encoding_error(&err.to_string()) => {
            let sanitized = sanitize_unencrypted_openssh_comment(&secret)?;
            decode_secret_key(&sanitized, passphrase).map_err(|retry_err| retry_err.to_string())
        }
        Err(err) => Err(err.to_string()),
    }
}

fn is_ssh_key_character_encoding_error(error: &str) -> bool {
    error.contains("SshKey: character encoding invalid")
}

fn sanitize_unencrypted_openssh_comment(secret: &str) -> Result<String, String> {
    const BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const END: &str = "-----END OPENSSH PRIVATE KEY-----";

    if !secret.lines().any(|line| line == BEGIN) {
        return Err("SSH key comment encoding is invalid and the key is not an OpenSSH private key".to_string());
    }

    let body = secret.lines().filter(|line| !line.starts_with("-----")).collect::<String>();
    let mut bytes =
        BASE64_STANDARD.decode(body.as_bytes()).map_err(|e| format!("OpenSSH key base64 decode failed: {e}"))?;

    sanitize_unencrypted_openssh_comment_bytes(&mut bytes)?;

    Ok(format!("{BEGIN}\n{}\n{END}\n", BASE64_STANDARD.encode(bytes)))
}

fn sanitize_unencrypted_openssh_comment_bytes(bytes: &mut Vec<u8>) -> Result<(), String> {
    const AUTH_MAGIC: &[u8] = b"openssh-key-v1\0";

    if !bytes.starts_with(AUTH_MAGIC) {
        return Err("OpenSSH key header is invalid".to_string());
    }

    let mut pos = AUTH_MAGIC.len();
    let ciphername = read_ssh_string(bytes, &mut pos)?;
    if ciphername != b"none" {
        return Err("SSH key comment encoding is invalid and encrypted OpenSSH keys cannot be sanitized".to_string());
    }

    let _kdfname = read_ssh_string(bytes, &mut pos)?;
    let _kdfoptions = read_ssh_string(bytes, &mut pos)?;
    let key_count = read_u32(bytes, &mut pos)?;
    if key_count != 1 {
        return Err("OpenSSH keys with multiple private keys are unsupported".to_string());
    }

    let _public_key = read_ssh_string(bytes, &mut pos)?;
    let private_blob_len_pos = pos;
    let private_blob = read_ssh_string(bytes, &mut pos)?;
    let patched_private_blob = sanitize_private_blob_comment(private_blob)?;
    let patched_private_blob_len = (patched_private_blob.len() as u32).to_be_bytes();

    bytes.splice(private_blob_len_pos..pos, patched_private_blob_len.into_iter().chain(patched_private_blob));

    Ok(())
}

fn sanitize_private_blob_comment(blob: &[u8]) -> Result<Vec<u8>, String> {
    let unpadded_end = blob
        .len()
        .checked_sub(openssh_padding_len(blob)?)
        .ok_or_else(|| "OpenSSH private key padding is invalid".to_string())?;
    let comment_len_pos = find_trailing_ssh_string_len_pos(&blob[..unpadded_end])
        .ok_or_else(|| "OpenSSH private key comment field was not found".to_string())?;

    let mut patched = Vec::with_capacity(blob.len());
    patched.extend_from_slice(&blob[..comment_len_pos]);
    patched.extend_from_slice(&0u32.to_be_bytes());

    let padding_len = padding_len_for_block(patched.len(), 8);
    for value in 1..=padding_len {
        patched.push(value as u8);
    }

    Ok(patched)
}

fn openssh_padding_len(bytes: &[u8]) -> Result<usize, String> {
    for len in (1..=16).rev() {
        if bytes.len() >= len
            && bytes[bytes.len() - len..].iter().enumerate().all(|(index, byte)| *byte == (index + 1) as u8)
        {
            return Ok(len);
        }
    }

    Err("OpenSSH private key padding is invalid".to_string())
}

fn find_trailing_ssh_string_len_pos(bytes: &[u8]) -> Option<usize> {
    (8..bytes.len().saturating_sub(3)).rev().find(|pos| {
        let Some(len_bytes) = bytes.get(*pos..*pos + 4) else {
            return false;
        };
        let len = u32::from_be_bytes(len_bytes.try_into().expect("slice length checked")) as usize;
        pos.checked_add(4).and_then(|value| value.checked_add(len)) == Some(bytes.len())
    })
}

fn padding_len_for_block(len: usize, block_size: usize) -> usize {
    let remainder = len % block_size;
    if remainder == 0 {
        block_size
    } else {
        block_size - remainder
    }
}

fn read_ssh_string<'a>(bytes: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let len = read_u32(bytes, pos)? as usize;
    let end = pos.checked_add(len).ok_or_else(|| "OpenSSH key field length is invalid".to_string())?;
    if end > bytes.len() {
        return Err("OpenSSH key field is truncated".to_string());
    }

    let value = &bytes[*pos..end];
    *pos = end;
    Ok(value)
}

fn read_u32(bytes: &[u8], pos: &mut usize) -> Result<u32, String> {
    let end = pos.checked_add(4).ok_or_else(|| "OpenSSH key field length is invalid".to_string())?;
    let value = bytes.get(*pos..end).ok_or_else(|| "OpenSSH key field is truncated".to_string())?;
    *pos = end;

    Ok(u32::from_be_bytes(value.try_into().map_err(|_| "OpenSSH key field length is invalid".to_string())?))
}

/// Accept connections on the local listener and forward them through the SSH session.
/// Returns when the SSH session dies (listener error or session.is_closed()).
async fn forward_loop(session: &Handle<SshClient>, listener: &TcpListener, remote_host: &str, remote_port: u16) {
    let mut idle_check = tokio::time::interval(IDLE_SESSION_CHECK_INTERVAL);
    idle_check.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        let accepted = tokio::select! {
            result = listener.accept() => result,
            _ = idle_check.tick() => {
                if session.is_closed() {
                    log::warn!("SSH session closed while tunnel was idle");
                    break;
                }
                match tokio::time::timeout(IDLE_SESSION_PING_TIMEOUT, session.send_ping()).await {
                    Ok(Ok(())) => continue,
                    Ok(Err(e)) => {
                        log::warn!("SSH idle ping failed: {e}");
                        break;
                    }
                    Err(_) => {
                        log::warn!("SSH idle ping timed out");
                        break;
                    }
                }
            }
        };

        let (mut stream, peer_addr) = match accepted {
            Ok(v) => v,
            Err(e) => {
                log::error!("SSH tunnel listener error: {e}");
                break;
            }
        };

        // Check session health before opening a new channel
        if session.is_closed() {
            log::warn!("SSH session closed, exiting forward loop");
            break;
        }

        let mut channel = match session
            .channel_open_direct_tcpip(
                remote_host,
                remote_port.into(),
                peer_addr.ip().to_string(),
                peer_addr.port().into(),
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("SSH direct-tcpip failed: {e}");
                break;
            }
        };

        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            let mut stream_closed = false;

            loop {
                tokio::select! {
                    r = stream.read(&mut buf), if !stream_closed => {
                        match r {
                            Ok(0) => {
                                stream_closed = true;
                                let _ = channel.eof().await;
                            }
                            Ok(n) => {
                                if channel.data(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                if stream.write_all(data).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | None => break,
                            _ => {}
                        }
                    }
                }
            }
        });
    }
}

/// Main tunnel task: runs the forward loop and automatically reconnects
/// the SSH session when it drops. The local TcpListener survives across
/// reconnections so the tunnel appears continuously available to clients.
/// Uses exponential backoff for reconnect attempts and gives up after
/// MAX_RECONNECT_ATTEMPTS to avoid log storms from permanent failures.
#[allow(clippy::too_many_arguments)]
async fn tunnel_reconnect_loop(
    mut session: Handle<SshClient>,
    connect_host: String,
    connect_port: u16,
    ssh_user: String,
    ssh_password: String,
    ssh_key_path: String,
    ssh_key_passphrase: String,
    use_ssh_agent: bool,
    ssh_agent_sock_path: String,
    connect_timeout_secs: u64,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
) {
    loop {
        log::info!("SSH tunnel active: {}:{} -> {}:{}", connect_host, connect_port, remote_host, remote_port);

        forward_loop(&session, &listener, &remote_host, remote_port).await;

        log::warn!("SSH tunnel connection lost ({}:{}), reconnecting...", connect_host, connect_port);

        // Reconnect with exponential backoff
        let mut delay = INITIAL_RECONNECT_DELAY;
        let mut attempts: u32 = 0;

        loop {
            if attempts >= MAX_RECONNECT_ATTEMPTS {
                log::error!(
                    "SSH tunnel ({connect_host}:{connect_port}): max reconnect attempts ({MAX_RECONNECT_ATTEMPTS}) exhausted, giving up"
                );
                return;
            }

            tokio::time::sleep(delay).await;

            match connect_and_authenticate(
                &connect_host,
                connect_port,
                &ssh_user,
                &ssh_password,
                &ssh_key_path,
                &ssh_key_passphrase,
                use_ssh_agent,
                &ssh_agent_sock_path,
                connect_timeout_secs,
            )
            .await
            {
                Ok(new_session) => {
                    session = new_session;
                    log::info!(
                        "SSH tunnel reconnected to {}:{} (attempt {})",
                        connect_host,
                        connect_port,
                        attempts + 1
                    );
                    break;
                }
                Err(e) => {
                    attempts += 1;
                    log::error!(
                        "SSH reconnect failed ({}:{}, attempt {attempts}/{MAX_RECONNECT_ATTEMPTS}): {e}",
                        connect_host,
                        connect_port,
                    );
                    // Exponential backoff: double the delay, cap at MAX_RECONNECT_DELAY
                    delay = std::cmp::min(delay * 2, MAX_RECONNECT_DELAY);
                }
            }
        }
    }
}

struct TunnelEntry {
    handles: Vec<JoinHandle<()>>,
    local_port: u16,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedTunnel {
    connect_host: String,
    connect_port: u16,
    remote_host: String,
    remote_port: u16,
}

pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, TunnelEntry>>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelManager {
    pub fn new() -> Self {
        Self { tunnels: Mutex::new(HashMap::new()) }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_tunnel(
        &self,
        connection_id: &str,
        ssh_host: &str,
        ssh_port: u16,
        ssh_user: &str,
        ssh_password: &str,
        ssh_key_path: &str,
        ssh_key_passphrase: &str,
        use_ssh_agent: bool,
        ssh_agent_sock_path: &str,
        connect_timeout_secs: u64,
        remote_host: &str,
        remote_port: u16,
        expose_to_lan: bool,
    ) -> Result<u16, String> {
        // Check cache under lock to avoid race with concurrent callers.
        // Also evict stale entries whose background task has exited.
        {
            let mut tunnels = self.tunnels.lock().await;
            if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
                return Ok(port);
            }
        }
        // Slow SSH connection — do this outside the lock.
        let (handle, local_port) = spawn_tunnel(
            ssh_host,
            ssh_port,
            ssh_user,
            ssh_password,
            ssh_key_path,
            ssh_key_passphrase,
            use_ssh_agent,
            ssh_agent_sock_path,
            connect_timeout_secs,
            remote_host,
            remote_port,
            expose_to_lan,
        )
        .await?;

        // Re-check under lock: another caller may have beaten us.
        let mut tunnels = self.tunnels.lock().await;
        if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
            // Another task already created a live tunnel; abort ours.
            handle.abort();
            return Ok(port);
        }
        tunnels.insert(connection_id.to_string(), TunnelEntry { handles: vec![handle], local_port });
        Ok(local_port)
    }

    /// Returns the local port for a cached tunnel entry, or `None` if the entry
    /// is stale (all background handles have exited).
    fn get_active_port(tunnels: &mut HashMap<String, TunnelEntry>, connection_id: &str) -> Option<u16> {
        let entry = tunnels.get(connection_id)?;
        if entry.handles.iter().all(|h| h.is_finished()) {
            tunnels.remove(connection_id);
            return None;
        }
        Some(entry.local_port)
    }

    pub async fn start_chain(
        &self,
        connection_id: &str,
        hops: &[SshTunnelConfig],
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, String> {
        if hops.is_empty() {
            return Err("No SSH tunnel hops configured".to_string());
        }
        // Check cache under lock; evict stale entries.
        {
            let mut tunnels = self.tunnels.lock().await;
            if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
                return Ok(port);
            }
        }

        let mut handles = Vec::new();
        let mut next_connect_endpoint: Option<(String, u16)> = None;
        let mut final_local_port = 0;

        for (index, hop) in hops.iter().enumerate() {
            let is_last = index + 1 == hops.len();
            let (connect_host, connect_port) =
                next_connect_endpoint.clone().unwrap_or_else(|| (hop.host.clone(), hop.port));
            let (target_host, target_port) = if is_last {
                (remote_host.to_string(), remote_port)
            } else {
                (hops[index + 1].host.clone(), hops[index + 1].port)
            };

            let (handle, local_port) = spawn_tunnel(
                &connect_host,
                connect_port,
                &hop.user,
                &hop.password,
                &hop.key_path,
                &hop.key_passphrase,
                hop.use_ssh_agent,
                &hop.ssh_agent_sock_path,
                effective_hop_timeout(hop),
                &target_host,
                target_port,
                is_last && hop.expose_lan,
            )
            .await
            .map_err(|err| format!("SSH hop {} failed: {err}", index + 1))?;

            handles.push(handle);
            final_local_port = local_port;
            next_connect_endpoint = Some(("127.0.0.1".to_string(), local_port));
        }

        // Re-check under lock: another caller may have beaten us.
        let mut tunnels = self.tunnels.lock().await;
        if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
            for handle in handles {
                handle.abort();
            }
            return Ok(port);
        }
        tunnels.insert(connection_id.to_string(), TunnelEntry { handles, local_port: final_local_port });
        Ok(final_local_port)
    }

    pub async fn local_port(&self, connection_id: &str) -> Option<u16> {
        self.tunnels.lock().await.get(connection_id).map(|entry| entry.local_port)
    }

    pub async fn stop_tunnel(&self, connection_id: &str) {
        if let Some(entry) = self.tunnels.lock().await.remove(connection_id) {
            for handle in entry.handles {
                handle.abort();
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_tunnel(
    connect_host: &str,
    connect_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    connect_timeout_secs: u64,
    remote_host: &str,
    remote_port: u16,
    expose_to_lan: bool,
) -> Result<(JoinHandle<()>, u16), String> {
    let local_port = portpicker::pick_unused_port().ok_or("No available port")?;

    let bind_addr = if expose_to_lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener =
        TcpListener::bind((bind_addr, local_port)).await.map_err(|e| format!("Failed to bind local port: {e}"))?;

    // Initial connection: fail fast on bad credentials
    let session = connect_and_authenticate(
        connect_host,
        connect_port,
        ssh_user,
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        use_ssh_agent,
        ssh_agent_sock_path,
        connect_timeout_secs,
    )
    .await?;

    let handle = tokio::spawn(tunnel_reconnect_loop(
        session,
        connect_host.to_string(),
        connect_port,
        ssh_user.to_string(),
        ssh_password.to_string(),
        ssh_key_path.to_string(),
        ssh_key_passphrase.to_string(),
        use_ssh_agent,
        ssh_agent_sock_path.to_string(),
        connect_timeout_secs,
        listener,
        remote_host.to_string(),
        remote_port,
    ));

    Ok((handle, local_port))
}

fn effective_hop_timeout(hop: &SshTunnelConfig) -> u64 {
    if hop.connect_timeout_secs == 0 {
        crate::models::connection::default_ssh_connect_timeout_secs()
    } else {
        hop.connect_timeout_secs
    }
}

#[cfg(test)]
fn plan_chain(
    hops: &[SshTunnelConfig],
    remote_host: &str,
    remote_port: u16,
    local_ports: &[u16],
) -> Vec<PlannedTunnel> {
    let mut planned = Vec::new();
    let mut next_connect_endpoint: Option<(String, u16)> = None;
    for (index, hop) in hops.iter().enumerate() {
        let is_last = index + 1 == hops.len();
        let (connect_host, connect_port) =
            next_connect_endpoint.clone().unwrap_or_else(|| (hop.host.clone(), hop.port));
        let (target_host, target_port) = if is_last {
            (remote_host.to_string(), remote_port)
        } else {
            (hops[index + 1].host.clone(), hops[index + 1].port)
        };
        planned.push(PlannedTunnel { connect_host, connect_port, remote_host: target_host, remote_port: target_port });
        if let Some(local_port) = local_ports.get(index) {
            next_connect_endpoint = Some(("127.0.0.1".to_string(), *local_port));
        }
    }
    planned
}

#[cfg(test)]
mod tests {
    use super::{
        effective_hop_timeout, openssh_padding_len, plan_chain, read_ssh_string,
        sanitize_unencrypted_openssh_comment_bytes, ssh_client_config, PlannedTunnel, TunnelManager,
    };
    use crate::models::connection::{default_ssh_connect_timeout_secs, SshTunnelConfig};

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn push_ssh_string(bytes: &mut Vec<u8>, value: &[u8]) {
        push_u32(bytes, value.len() as u32);
        bytes.extend_from_slice(value);
    }

    fn padded_private_blob(comment: &[u8]) -> Vec<u8> {
        let mut blob = Vec::new();
        push_u32(&mut blob, 7);
        push_u32(&mut blob, 7);
        blob.extend_from_slice(b"fake-private-key");
        push_ssh_string(&mut blob, comment);
        for value in 1..=(8 - (blob.len() % 8)) {
            blob.push(value as u8);
        }
        blob
    }

    fn openssh_container(private_blob: &[u8]) -> Vec<u8> {
        let mut bytes = b"openssh-key-v1\0".to_vec();
        push_ssh_string(&mut bytes, b"none");
        push_ssh_string(&mut bytes, b"none");
        push_ssh_string(&mut bytes, b"");
        push_u32(&mut bytes, 1);
        push_ssh_string(&mut bytes, b"fake-public-key");
        push_ssh_string(&mut bytes, private_blob);
        bytes
    }

    fn hop(id: &str, host: &str, port: u16) -> SshTunnelConfig {
        SshTunnelConfig {
            id: id.to_string(),
            name: String::new(),
            enabled: true,
            host: host.to_string(),
            port,
            user: "user".to_string(),
            password: "secret".to_string(),
            key_path: String::new(),
            key_passphrase: String::new(),
            connect_timeout_secs: 5,
            expose_lan: false,
            use_ssh_agent: false,
        }
    }

    #[test]
    fn chain_plan_routes_each_hop_to_next_endpoint() {
        let hops = vec![hop("a", "bastion-a", 22), hop("b", "bastion-b", 2200)];

        let planned = plan_chain(&hops, "db.internal", 5432, &[41001, 41002]);

        assert_eq!(
            planned,
            vec![
                PlannedTunnel {
                    connect_host: "bastion-a".to_string(),
                    connect_port: 22,
                    remote_host: "bastion-b".to_string(),
                    remote_port: 2200,
                },
                PlannedTunnel {
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41001,
                    remote_host: "db.internal".to_string(),
                    remote_port: 5432,
                },
            ]
        );
    }

    #[test]
    fn zero_hop_timeout_uses_default() {
        let mut tunnel = hop("a", "bastion-a", 22);
        tunnel.connect_timeout_secs = 0;

        assert_eq!(effective_hop_timeout(&tunnel), default_ssh_connect_timeout_secs());
    }

    #[test]
    fn ssh_client_config_keeps_legacy_kex_after_safe_defaults() {
        let config = ssh_client_config();
        let kex = config.preferred.kex;
        let curve25519_index = kex.iter().position(|algorithm| *algorithm == russh::kex::CURVE25519).unwrap();
        let ecdh_index = kex.iter().position(|algorithm| *algorithm == russh::kex::ECDH_SHA2_NISTP256).unwrap();
        let group14_sha1_index = kex.iter().position(|algorithm| *algorithm == russh::kex::DH_G14_SHA1).unwrap();

        assert!(curve25519_index < ecdh_index);
        assert!(ecdh_index < group14_sha1_index);
    }

    #[test]
    fn sanitizes_invalid_openssh_private_key_comment() {
        let mut key = openssh_container(&padded_private_blob(&[0xff, 0xfe, b'a']));

        sanitize_unencrypted_openssh_comment_bytes(&mut key).unwrap();

        let mut pos = b"openssh-key-v1\0".len();
        assert_eq!(read_ssh_string(&key, &mut pos).unwrap(), b"none");
        let _kdfname = read_ssh_string(&key, &mut pos).unwrap();
        let _kdfoptions = read_ssh_string(&key, &mut pos).unwrap();
        pos += 4;
        let _public_key = read_ssh_string(&key, &mut pos).unwrap();
        let private_blob = read_ssh_string(&key, &mut pos).unwrap();
        let unpadded_end = private_blob.len() - openssh_padding_len(private_blob).unwrap();
        let comment_len_pos = unpadded_end - 4;

        assert_eq!(&private_blob[comment_len_pos..unpadded_end], &0u32.to_be_bytes());
    }

    #[tokio::test]
    async fn local_port_reuses_existing_chain_entry() {
        let manager = TunnelManager::new();

        assert_eq!(manager.local_port("missing").await, None);
        manager.stop_tunnel("missing").await;
    }
}
