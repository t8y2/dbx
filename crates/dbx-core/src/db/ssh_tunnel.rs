use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{self, Config, Handle};
use russh::keys::{key::PrivateKeyWithHashAlg, load_secret_key};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

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
) -> Result<Handle<SshClient>, String> {
    let config = Arc::new(Config {
        nodelay: true,
        ..Default::default()
    });

    let mut session = client::connect(config, (ssh_host, ssh_port), SshClient {})
        .await
        .map_err(|e| format!("SSH connection failed: {e}"))?;

    if !ssh_key_path.is_empty() {
        let passphrase = if ssh_key_passphrase.is_empty() { None } else { Some(ssh_key_passphrase) };
        let key_pair = load_secret_key(ssh_key_path, passphrase)
            .map_err(|e| format!("Failed to load SSH key: {e}"))?;
        let auth_res = session
            .authenticate_publickey(
                ssh_user,
                PrivateKeyWithHashAlg::new(
                    Arc::new(key_pair),
                    session
                        .best_supported_rsa_hash()
                        .await
                        .ok()
                        .flatten()
                        .flatten(),
                ),
            )
            .await
            .map_err(|e| format!("SSH key auth failed: {e}"))?;
        if !auth_res.success() {
            return Err("SSH public key authentication failed".to_string());
        }
    } else if !ssh_password.is_empty() {
        let auth_res = session
            .authenticate_password(ssh_user, ssh_password)
            .await
            .map_err(|e| format!("SSH password auth failed: {e}"))?;
        if !auth_res.success() {
            return Err("SSH password authentication failed".to_string());
        }
    } else {
        return Err("No SSH password or key provided".to_string());
    }

    Ok(session)
}

async fn forward_loop(
    session: Handle<SshClient>,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
) {
    loop {
        let (mut stream, peer_addr) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => break,
        };

        let mut channel = match session
            .channel_open_direct_tcpip(
                &remote_host,
                remote_port.into(),
                peer_addr.ip().to_string(),
                peer_addr.port().into(),
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("SSH direct-tcpip failed: {e}");
                continue;
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

pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, (JoinHandle<()>, u16)>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
        }
    }

    pub async fn start_tunnel(
        &self,
        connection_id: &str,
        ssh_host: &str,
        ssh_port: u16,
        ssh_user: &str,
        ssh_password: &str,
        ssh_key_path: &str,
        ssh_key_passphrase: &str,
        remote_host: &str,
        remote_port: u16,
        expose_to_lan: bool,
    ) -> Result<u16, String> {
        let local_port = portpicker::pick_unused_port().ok_or("No available port")?;

        let session =
            connect_and_authenticate(ssh_host, ssh_port, ssh_user, ssh_password, ssh_key_path, ssh_key_passphrase)
                .await?;

        let bind_addr = if expose_to_lan { "0.0.0.0" } else { "127.0.0.1" };
        let listener = TcpListener::bind((bind_addr, local_port))
            .await
            .map_err(|e| format!("Failed to bind local port: {e}"))?;

        let remote_host = remote_host.to_string();
        let handle = tokio::spawn(forward_loop(session, listener, remote_host, remote_port));

        self.tunnels
            .lock()
            .await
            .insert(connection_id.to_string(), (handle, local_port));

        Ok(local_port)
    }

    pub async fn local_port(&self, connection_id: &str) -> Option<u16> {
        self.tunnels
            .lock()
            .await
            .get(connection_id)
            .map(|(_, port)| *port)
    }

    pub async fn stop_tunnel(&self, connection_id: &str) {
        if let Some((handle, _)) = self.tunnels.lock().await.remove(connection_id) {
            handle.abort();
        }
    }
}
