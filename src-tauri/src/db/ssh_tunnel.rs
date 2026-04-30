use std::collections::HashMap;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, (Child, u16)>>,
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
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, String> {
        let local_port = portpicker::pick_unused_port().ok_or("No available port")?;

        let mut ssh_args = vec![
            "-N".to_string(),
            "-o".to_string(), "StrictHostKeyChecking=no".to_string(),
            "-o".to_string(), "ServerAliveInterval=60".to_string(),
            "-L".to_string(), format!("{local_port}:{remote_host}:{remote_port}"),
            "-p".to_string(), ssh_port.to_string(),
        ];

        if !ssh_key_path.is_empty() {
            ssh_args.push("-i".to_string());
            ssh_args.push(ssh_key_path.to_string());
        }

        ssh_args.push(format!("{ssh_user}@{ssh_host}"));

        let child = if !ssh_password.is_empty() && ssh_key_path.is_empty() {
            Command::new("sshpass")
                .arg("-p").arg(ssh_password)
                .arg("ssh")
                .args(&ssh_args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        "SSH password auth requires 'sshpass'. Install it: brew install sshpass (macOS) / apt install sshpass (Linux)".to_string()
                    } else {
                        format!("Failed to start SSH tunnel: {e}")
                    }
                })?
        } else {
            Command::new("ssh")
                .args(&ssh_args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("Failed to start SSH tunnel: {e}"))?
        };

        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

        self.tunnels
            .lock()
            .await
            .insert(connection_id.to_string(), (child, local_port));

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
        if let Some((mut child, _)) = self.tunnels.lock().await.remove(connection_id) {
            let _ = child.kill().await;
        }
    }
}
