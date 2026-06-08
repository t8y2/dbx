use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{self, Config, Handle};
use russh::keys::{key::PrivateKeyWithHashAlg, load_secret_key};
use russh::ChannelMsg;
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

async fn connect_and_authenticate(
    ssh_host: &str,
    ssh_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    connect_timeout_secs: u64,
) -> Result<Handle<SshClient>, String> {
    let config =
        Arc::new(Config { nodelay: true, keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() });
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
        let key_pair = load_secret_key(ssh_key_path, passphrase).map_err(|e| format!("Failed to load SSH key: {e}"))?;
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
    } else {
        return Err("No SSH password or key provided".to_string());
    }

    Ok(session)
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
    use super::{effective_hop_timeout, plan_chain, PlannedTunnel, TunnelManager};
    use crate::models::connection::{default_ssh_connect_timeout_secs, SshTunnelConfig};

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

    #[tokio::test]
    async fn local_port_reuses_existing_chain_entry() {
        let manager = TunnelManager::new();

        assert_eq!(manager.local_port("missing").await, None);
        manager.stop_tunnel("missing").await;
    }
}
