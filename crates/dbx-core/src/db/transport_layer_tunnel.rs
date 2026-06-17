use crate::models::connection::TransportLayerConfig;

use super::proxy_tunnel::ProxyTunnelManager;
use super::ssh_tunnel::TunnelManager;

#[derive(Debug, Clone, PartialEq, Eq)]
struct LayerEndpoint {
    host: String,
    port: u16,
}

impl LayerEndpoint {
    fn localhost(port: u16) -> Self {
        Self { host: "127.0.0.1".to_string(), port }
    }
}

/// Starts an ordered transport layer chain and returns the final local port.
///
/// Each layer listens on a local port. The next layer connects to that local
/// port, and the last layer forwards to `remote_host:remote_port`.
pub async fn start_transport_layers(
    connection_id: &str,
    layers: &[TransportLayerConfig],
    remote_host: &str,
    remote_port: u16,
    ssh_tunnels: &TunnelManager,
    proxy_tunnels: &ProxyTunnelManager,
) -> Result<u16, String> {
    if layers.is_empty() {
        return Err("No transport layers configured".to_string());
    }

    let mut next_connect_endpoint: Option<LayerEndpoint> = None;
    let mut final_local_port = 0;

    for (index, layer) in layers.iter().enumerate() {
        let layer_id = layer_id(connection_id, index);
        let is_last = index + 1 == layers.len();
        let (layer_host, layer_port) = layer.endpoint();
        let connect_endpoint = next_connect_endpoint
            .clone()
            .unwrap_or_else(|| LayerEndpoint { host: layer_host.to_string(), port: layer_port });
        let target_endpoint = if is_last {
            LayerEndpoint { host: remote_host.to_string(), port: remote_port }
        } else {
            let (next_host, next_port) = layers[index + 1].endpoint();
            LayerEndpoint { host: next_host.to_string(), port: next_port }
        };

        let local_port = match layer {
            TransportLayerConfig::Ssh(ssh) => ssh_tunnels
                .start_tunnel(
                    &layer_id,
                    &connect_endpoint.host,
                    connect_endpoint.port,
                    &ssh.user,
                    &ssh.password,
                    &ssh.key_path,
                    &ssh.key_passphrase,
                    ssh.use_ssh_agent,
                    &ssh.ssh_agent_sock_path,
                    effective_ssh_connect_timeout_secs(ssh.connect_timeout_secs),
                    &target_endpoint.host,
                    target_endpoint.port,
                    is_last && ssh.expose_lan,
                )
                .await
                .map_err(|err| format!("SSH layer {} failed: {err}", index + 1))?,
            TransportLayerConfig::Proxy(proxy) => proxy_tunnels
                .start_tunnel(
                    &layer_id,
                    proxy.proxy_type,
                    &connect_endpoint.host,
                    connect_endpoint.port,
                    &proxy.username,
                    &proxy.password,
                    &target_endpoint.host,
                    target_endpoint.port,
                )
                .await
                .map_err(|err| format!("Proxy layer {} failed: {err}", index + 1))?,
        };

        final_local_port = local_port;
        next_connect_endpoint = Some(LayerEndpoint::localhost(local_port));
    }

    Ok(final_local_port)
}

pub async fn stop_transport_layers(
    connection_id: &str,
    layer_count: usize,
    ssh_tunnels: &TunnelManager,
    proxy_tunnels: &ProxyTunnelManager,
) {
    for index in 0..layer_count {
        let layer_id = layer_id(connection_id, index);
        ssh_tunnels.stop_tunnel(&layer_id).await;
        proxy_tunnels.stop_tunnel(&layer_id).await;
    }
}

fn layer_id(connection_id: &str, index: usize) -> String {
    format!("{connection_id}:transport:{index}")
}

fn effective_ssh_connect_timeout_secs(value: u64) -> u64 {
    if value == 0 {
        crate::models::connection::default_ssh_connect_timeout_secs()
    } else {
        value
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
enum PlannedLayerType {
    Ssh,
    Proxy,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedTransportLayer {
    layer_type: PlannedLayerType,
    connect_host: String,
    connect_port: u16,
    remote_host: String,
    remote_port: u16,
}

#[cfg(test)]
fn plan_transport_layers(
    layers: &[TransportLayerConfig],
    remote_host: &str,
    remote_port: u16,
    local_ports: &[u16],
) -> Vec<PlannedTransportLayer> {
    let mut planned = Vec::new();
    let mut next_connect_endpoint: Option<(String, u16)> = None;
    for (index, layer) in layers.iter().enumerate() {
        let is_last = index + 1 == layers.len();
        let (layer_host, layer_port) = layer.endpoint();
        let (connect_host, connect_port) =
            next_connect_endpoint.clone().unwrap_or_else(|| (layer_host.to_string(), layer_port));
        let (target_host, target_port) = if is_last {
            (remote_host.to_string(), remote_port)
        } else {
            let (next_host, next_port) = layers[index + 1].endpoint();
            (next_host.to_string(), next_port)
        };
        let layer_type = match layer {
            TransportLayerConfig::Ssh(_) => PlannedLayerType::Ssh,
            TransportLayerConfig::Proxy(_) => PlannedLayerType::Proxy,
        };
        planned.push(PlannedTransportLayer {
            layer_type,
            connect_host,
            connect_port,
            remote_host: target_host,
            remote_port: target_port,
        });
        if let Some(local_port) = local_ports.get(index) {
            next_connect_endpoint = Some(("127.0.0.1".to_string(), *local_port));
        }
    }
    planned
}

#[cfg(test)]
mod tests {
    use super::{plan_transport_layers, PlannedLayerType, PlannedTransportLayer};
    use crate::models::connection::{ProxyTunnelConfig, ProxyType, SshTunnelConfig, TransportLayerConfig};

    fn ssh_layer(id: &str, host: &str, port: u16) -> TransportLayerConfig {
        TransportLayerConfig::Ssh(SshTunnelConfig {
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
        })
    }

    fn proxy_layer(id: &str, host: &str, port: u16) -> TransportLayerConfig {
        TransportLayerConfig::Proxy(ProxyTunnelConfig {
            id: id.to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: host.to_string(),
            port,
            username: String::new(),
            password: String::new(),
        })
    }

    #[test]
    fn mixed_transport_plan_routes_layers_in_configured_order() {
        let layers = vec![
            ssh_layer("ssh-a", "bastion-a", 22),
            proxy_layer("proxy", "proxy.internal", 1080),
            ssh_layer("ssh-b", "bastion-b", 2200),
        ];

        let planned = plan_transport_layers(&layers, "db.internal", 5432, &[41001, 41002, 41003]);

        assert_eq!(
            planned,
            vec![
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::Ssh,
                    connect_host: "bastion-a".to_string(),
                    connect_port: 22,
                    remote_host: "proxy.internal".to_string(),
                    remote_port: 1080,
                },
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::Proxy,
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41001,
                    remote_host: "bastion-b".to_string(),
                    remote_port: 2200,
                },
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::Ssh,
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41002,
                    remote_host: "db.internal".to_string(),
                    remote_port: 5432,
                },
            ]
        );
    }
}
