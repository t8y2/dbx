use crate::models::connection::{SshTunnelConfig, TransportLayerConfig};

use super::http_tunnel::HttpTunnelManager;
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

/// Resolves any `~/.ssh/config` aliases on SSH layers before endpoints are
/// computed. Both `.endpoint()` read sites below (the current layer's own
/// connect target, and an earlier layer's forward target when this layer is
/// the *next* one in the chain) must see the resolved host/port rather than
/// a literal alias string, so resolution happens once up front instead of
/// only at the `start_tunnel` call site.
///
/// An SSH layer's alias may itself resolve to more than one hop (its
/// `~/.ssh/config` entry declares `ProxyJump`); every other layer, and every
/// SSH layer without `ProxyJump`, resolves to exactly one element. `None` is
/// returned for non-SSH layers.
fn resolve_ssh_layer_chains(
    layers: &[TransportLayerConfig],
    resolve: impl Fn(&SshTunnelConfig) -> Vec<SshTunnelConfig>,
) -> Vec<Option<Vec<SshTunnelConfig>>> {
    layers
        .iter()
        .map(|layer| match layer {
            TransportLayerConfig::Ssh(ssh) => Some(resolve(ssh)),
            _ => None,
        })
        .collect()
}

#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedTransportLayers {
    layers: Vec<TransportLayerConfig>,
    ssh_chains: Vec<Option<Vec<SshTunnelConfig>>>,
}

impl ResolvedTransportLayers {
    pub fn resolve(layers: &[TransportLayerConfig]) -> Result<Self, String> {
        Self::resolve_with(layers, crate::ssh_config::resolve_ssh_tunnel_chain)
    }

    fn resolve_with(
        layers: &[TransportLayerConfig],
        resolve: impl Fn(&SshTunnelConfig) -> Vec<SshTunnelConfig>,
    ) -> Result<Self, String> {
        validate_transport_layers(layers)?;
        let mut ssh_chains = resolve_ssh_layer_chains(layers, resolve);
        for (index, chain) in ssh_chains.iter_mut().enumerate() {
            if let Some(chain) = chain {
                if chain.len() > 1 && index != 0 {
                    return Err(format!(
                        "SSH layer {} uses a multi-hop `~/.ssh/config` ProxyJump chain, which DBX only supports as the first transport layer. Add the jump host as its own tunnel layer instead.",
                        index + 1
                    ));
                }
                for hop in chain {
                    hop.id.clear();
                    hop.name.clear();
                    hop.profile_id.clear();
                    hop.enabled = true;
                }
            }
        }
        let layers = layers
            .iter()
            .zip(&ssh_chains)
            .map(|(layer, chain)| {
                let mut layer = match chain {
                    Some(chain) => TransportLayerConfig::Ssh(chain[0].clone()),
                    None => layer.clone(),
                };
                normalize_layer_identity(&mut layer);
                layer
            })
            .collect();
        Ok(Self { layers, ssh_chains })
    }

    pub fn layers(&self) -> &[TransportLayerConfig] {
        &self.layers
    }

    pub fn prefix(&self, layer_count: usize) -> Self {
        Self { layers: self.layers[..layer_count].to_vec(), ssh_chains: self.ssh_chains[..layer_count].to_vec() }
    }

    pub async fn start(
        &self,
        connection_id: &str,
        remote_host: &str,
        remote_port: u16,
        ssh_tunnels: &TunnelManager,
        proxy_tunnels: &ProxyTunnelManager,
        http_tunnels: &HttpTunnelManager,
    ) -> Result<u16, String> {
        self.start_with_final_ssh_local_port(
            connection_id,
            remote_host,
            remote_port,
            None,
            ssh_tunnels,
            proxy_tunnels,
            http_tunnels,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_with_final_ssh_local_port(
        &self,
        connection_id: &str,
        remote_host: &str,
        remote_port: u16,
        final_ssh_local_port: Option<u16>,
        ssh_tunnels: &TunnelManager,
        proxy_tunnels: &ProxyTunnelManager,
        http_tunnels: &HttpTunnelManager,
    ) -> Result<u16, String> {
        start_transport_layers_internal(
            connection_id,
            self,
            remote_host,
            remote_port,
            final_ssh_local_port,
            false,
            ssh_tunnels,
            proxy_tunnels,
            http_tunnels,
        )
        .await
    }

    pub async fn start_with_final_ssh_socks5(
        &self,
        connection_id: &str,
        ssh_tunnels: &TunnelManager,
        proxy_tunnels: &ProxyTunnelManager,
        http_tunnels: &HttpTunnelManager,
    ) -> Result<u16, String> {
        if !matches!(self.layers.last(), Some(TransportLayerConfig::Ssh(_))) {
            return Err("Dynamic SOCKS5 routing requires SSH as the final transport layer".to_string());
        }
        start_transport_layers_internal(
            connection_id,
            self,
            "",
            0,
            None,
            true,
            ssh_tunnels,
            proxy_tunnels,
            http_tunnels,
        )
        .await
    }
}

fn normalize_layer_identity(layer: &mut TransportLayerConfig) {
    match layer {
        TransportLayerConfig::Ssh(layer) => {
            layer.id.clear();
            layer.name.clear();
            layer.profile_id.clear();
            layer.enabled = true;
        }
        TransportLayerConfig::Proxy(layer) => {
            layer.id.clear();
            layer.name.clear();
            layer.profile_id.clear();
            layer.enabled = true;
            layer.test_target = None;
        }
        TransportLayerConfig::HttpTunnel(layer) => {
            layer.id.clear();
            layer.name.clear();
            layer.profile_id.clear();
            layer.enabled = true;
        }
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
    http_tunnels: &HttpTunnelManager,
) -> Result<u16, String> {
    start_transport_layers_with_final_ssh_local_port(
        connection_id,
        layers,
        remote_host,
        remote_port,
        None,
        ssh_tunnels,
        proxy_tunnels,
        http_tunnels,
    )
    .await
}

pub async fn start_transport_layers_with_final_ssh_local_port(
    connection_id: &str,
    layers: &[TransportLayerConfig],
    remote_host: &str,
    remote_port: u16,
    final_ssh_local_port: Option<u16>,
    ssh_tunnels: &TunnelManager,
    proxy_tunnels: &ProxyTunnelManager,
    http_tunnels: &HttpTunnelManager,
) -> Result<u16, String> {
    ResolvedTransportLayers::resolve(layers)?
        .start_with_final_ssh_local_port(
            connection_id,
            remote_host,
            remote_port,
            final_ssh_local_port,
            ssh_tunnels,
            proxy_tunnels,
            http_tunnels,
        )
        .await
}

/// Starts the layer chain with the final SSH hop exposing a dynamic SOCKS5
/// endpoint (ssh -D) instead of a static forward, so callers can route many
/// remote endpoints through one tunnel (RocketMQ name servers/brokers, plugin
/// providers with `proxy_route`, ...).
pub async fn start_transport_layers_with_final_ssh_socks5(
    connection_id: &str,
    layers: &[TransportLayerConfig],
    ssh_tunnels: &TunnelManager,
    proxy_tunnels: &ProxyTunnelManager,
    http_tunnels: &HttpTunnelManager,
) -> Result<u16, String> {
    if !matches!(layers.last(), Some(TransportLayerConfig::Ssh(_))) {
        return Err("Dynamic SOCKS5 routing requires SSH as the final transport layer".to_string());
    }
    ResolvedTransportLayers::resolve(layers)?
        .start_with_final_ssh_socks5(connection_id, ssh_tunnels, proxy_tunnels, http_tunnels)
        .await
}

#[allow(clippy::too_many_arguments)]
async fn start_transport_layers_internal(
    connection_id: &str,
    resolved: &ResolvedTransportLayers,
    remote_host: &str,
    remote_port: u16,
    final_ssh_local_port: Option<u16>,
    final_ssh_socks5: bool,
    ssh_tunnels: &TunnelManager,
    proxy_tunnels: &ProxyTunnelManager,
    http_tunnels: &HttpTunnelManager,
) -> Result<u16, String> {
    let layers = &resolved.layers;
    if layers.is_empty() {
        return Err("No transport layers configured".to_string());
    }
    let ssh_chains = &resolved.ssh_chains;
    let entry_endpoint = |index: usize| -> (String, u16) {
        match &ssh_chains[index] {
            Some(chain) => {
                let first = &chain[0];
                (first.host.clone(), first.port)
            }
            None => {
                let (host, port) = layers[index].endpoint();
                (host.to_string(), port)
            }
        }
    };

    let mut next_connect_endpoint: Option<LayerEndpoint> = None;
    let mut final_local_port = 0;

    for (index, layer) in layers.iter().enumerate() {
        let layer_id = layer_id(connection_id, index);
        let is_last = index + 1 == layers.len();
        let (layer_host, layer_port) = entry_endpoint(index);
        let connect_endpoint =
            next_connect_endpoint.clone().unwrap_or(LayerEndpoint { host: layer_host, port: layer_port });
        let target_endpoint = if is_last {
            LayerEndpoint { host: remote_host.to_string(), port: remote_port }
        } else {
            let (next_host, next_port) = entry_endpoint(index + 1);
            LayerEndpoint { host: next_host, port: next_port }
        };

        let local_port =
            match (layer, &ssh_chains[index]) {
                (TransportLayerConfig::Ssh(_), Some(chain)) if chain.len() > 1 => {
                    if is_last && final_ssh_socks5 {
                        return Err("Dynamic SOCKS5 routing does not support a multi-hop SSH (ProxyJump) profile yet."
                            .to_string());
                    }
                    if is_last && final_ssh_local_port.is_some() {
                        return Err("A fixed local port is not supported for a multi-hop SSH (ProxyJump) profile yet."
                            .to_string());
                    }
                    ssh_tunnels
                        .start_chain(&layer_id, chain, &target_endpoint.host, target_endpoint.port)
                        .await
                        .map_err(|err| format!("SSH layer {} failed: {err}", index + 1))?
                }
                (TransportLayerConfig::Ssh(_), Some(chain)) if is_last && final_ssh_socks5 => {
                    let resolved = &chain[0];
                    ssh_tunnels
                        .start_socks5_proxy(
                            &layer_id,
                            &connect_endpoint.host,
                            connect_endpoint.port,
                            &resolved.host,
                            resolved.port,
                            &resolved.user,
                            &resolved.password,
                            &resolved.key_path,
                            &resolved.key_passphrase,
                            resolved.use_ssh_agent,
                            &resolved.ssh_agent_sock_path,
                            &resolved.ssh_agent_key_fingerprint,
                            &resolved.auth_method,
                            effective_ssh_connect_timeout_secs(resolved.connect_timeout_secs),
                            resolved.allow_exec_channel_proxy,
                            &resolved.proxy_command,
                        )
                        .await
                        .map_err(|err| format!("SSH layer {} failed: {err}", index + 1))?
                }
                (TransportLayerConfig::Ssh(_), Some(chain)) => {
                    let resolved = &chain[0];
                    ssh_tunnels
                        .start_tunnel_on_local_port(
                            &layer_id,
                            &connect_endpoint.host,
                            connect_endpoint.port,
                            &resolved.host,
                            resolved.port,
                            &resolved.user,
                            &resolved.password,
                            &resolved.key_path,
                            &resolved.key_passphrase,
                            resolved.use_ssh_agent,
                            &resolved.ssh_agent_sock_path,
                            &resolved.ssh_agent_key_fingerprint,
                            &resolved.auth_method,
                            effective_ssh_connect_timeout_secs(resolved.connect_timeout_secs),
                            &target_endpoint.host,
                            target_endpoint.port,
                            is_last && resolved.expose_lan,
                            resolved.allow_exec_channel_proxy,
                            if is_last { final_ssh_local_port } else { None },
                            &resolved.proxy_command,
                        )
                        .await
                        .map_err(|err| format!("SSH layer {} failed: {err}", index + 1))?
                }
                (TransportLayerConfig::Proxy(proxy), None) => proxy_tunnels
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
                (TransportLayerConfig::HttpTunnel(http), None) => http_tunnels
                    .start_tunnel(
                        &layer_id,
                        &http.url,
                        &http.token,
                        http.connect_timeout_secs,
                        &target_endpoint.host,
                        target_endpoint.port,
                    )
                    .await
                    .map_err(|err| format!("HTTP tunnel layer {} failed: {err}", index + 1))?,
                (TransportLayerConfig::Proxy(_) | TransportLayerConfig::HttpTunnel(_), Some(_))
                | (TransportLayerConfig::Ssh(_), None) => {
                    unreachable!("resolve_ssh_layer_chains produces Some(_) iff the layer is TransportLayerConfig::Ssh")
                }
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
    http_tunnels: &HttpTunnelManager,
) {
    for index in 0..layer_count {
        let layer_id = layer_id(connection_id, index);
        ssh_tunnels.stop_tunnel(&layer_id).await;
        proxy_tunnels.stop_tunnel(&layer_id).await;
        http_tunnels.stop_tunnel(&layer_id).await;
    }
}

fn validate_transport_layers(layers: &[TransportLayerConfig]) -> Result<(), String> {
    for (index, layer) in layers.iter().enumerate() {
        if matches!(layer, TransportLayerConfig::HttpTunnel(_)) && index != 0 {
            return Err("HTTP tunnel must be the first transport layer".to_string());
        }
    }
    Ok(())
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
    HttpTunnel,
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
    plan_transport_layers_with_resolver(layers, remote_host, remote_port, local_ports, |ssh| vec![ssh.clone()])
}

/// Same as `plan_transport_layers`, but takes an explicit SSH-alias resolver
/// so tests can exercise `~/.ssh/config` resolution (including a `ProxyJump`
/// chain) without touching the real filesystem — mirrors `start_transport_layers`'s
/// use of `resolve_ssh_layer_chains`. Each planned SSH layer covers only its
/// *first* hop's connect endpoint; a chain's internal hops are exercised by
/// `resolve_ssh_tunnel_chain`'s own unit tests in `ssh_config.rs`; not
/// re-planned here.
#[cfg(test)]
fn plan_transport_layers_with_resolver(
    layers: &[TransportLayerConfig],
    remote_host: &str,
    remote_port: u16,
    local_ports: &[u16],
    resolve: impl Fn(&crate::models::connection::SshTunnelConfig) -> Vec<crate::models::connection::SshTunnelConfig>,
) -> Vec<PlannedTransportLayer> {
    let ssh_chains = resolve_ssh_layer_chains(layers, resolve);
    let entry_endpoint = |index: usize| -> (String, u16) {
        match &ssh_chains[index] {
            Some(chain) => (chain[0].host.clone(), chain[0].port),
            None => {
                let (host, port) = layers[index].endpoint();
                (host.to_string(), port)
            }
        }
    };
    let mut planned = Vec::new();
    let mut next_connect_endpoint: Option<(String, u16)> = None;
    for (index, layer) in layers.iter().enumerate() {
        let is_last = index + 1 == layers.len();
        let (layer_host, layer_port) = entry_endpoint(index);
        let (connect_host, connect_port) = next_connect_endpoint.clone().unwrap_or((layer_host, layer_port));
        let (target_host, target_port) =
            if is_last { (remote_host.to_string(), remote_port) } else { entry_endpoint(index + 1) };
        let layer_type = match layer {
            TransportLayerConfig::Ssh(_) => PlannedLayerType::Ssh,
            TransportLayerConfig::Proxy(_) => PlannedLayerType::Proxy,
            TransportLayerConfig::HttpTunnel(_) => PlannedLayerType::HttpTunnel,
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
    use super::{
        plan_transport_layers, plan_transport_layers_with_resolver, validate_transport_layers, PlannedLayerType,
        PlannedTransportLayer, ResolvedTransportLayers,
    };
    use crate::models::connection::{
        HttpTunnelConfig, ProxyTunnelConfig, ProxyType, SshTunnelConfig, TransportLayerConfig,
    };

    fn ssh_layer(id: &str, host: &str, port: u16) -> TransportLayerConfig {
        TransportLayerConfig::Ssh(SshTunnelConfig {
            profile_id: String::new(),
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
            local_port: None,
            use_ssh_agent: false,
            ssh_agent_sock_path: String::new(),
            ssh_agent_key_fingerprint: String::new(),
            auth_method: "password".to_string(),
            allow_exec_channel_proxy: false,
            proxy_command: String::new(),
        })
    }

    fn proxy_layer(id: &str, host: &str, port: u16) -> TransportLayerConfig {
        TransportLayerConfig::Proxy(ProxyTunnelConfig {
            profile_id: String::new(),
            id: id.to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: host.to_string(),
            port,
            username: String::new(),
            password: String::new(),
            test_target: None,
        })
    }

    fn http_tunnel_layer(id: &str, url: &str) -> TransportLayerConfig {
        TransportLayerConfig::HttpTunnel(HttpTunnelConfig {
            profile_id: String::new(),
            id: id.to_string(),
            name: String::new(),
            enabled: true,
            url: url.to_string(),
            token: String::new(),
            protocol: dbx_types::models::connection::HttpTunnelProtocol::DbxTcp,
            connect_timeout_secs: 10,
        })
    }

    #[test]
    fn resolved_transport_compares_the_actual_ssh_chain_not_its_alias_or_display_fields() {
        let alias = ssh_layer("original", "db-alias", 22);
        let canonical = ssh_layer("other", "canonical-alias", 22);
        let resolve = |_: &SshTunnelConfig| {
            let TransportLayerConfig::Ssh(hop) = ssh_layer("profile", "jump.example", 2222) else { unreachable!() };
            vec![hop]
        };
        let first = ResolvedTransportLayers::resolve_with(&[alias], resolve).unwrap();
        let second = ResolvedTransportLayers::resolve_with(&[canonical], resolve).unwrap();
        assert!(first == second);
        assert_eq!(first.layers()[0].endpoint(), ("jump.example", 2222));
        assert_eq!(first.layers()[0].id(), "");
    }

    #[test]
    fn resolved_transport_retains_all_actual_hops_and_credentials() {
        let alias = ssh_layer("source", "db-alias", 22);
        let resolve = |password: &str| {
            ResolvedTransportLayers::resolve_with(std::slice::from_ref(&alias), |_| {
                let TransportLayerConfig::Ssh(first) = ssh_layer("jump", "jump.example", 22) else { unreachable!() };
                let TransportLayerConfig::Ssh(mut last) = ssh_layer("last", "db-gateway.example", 2222) else {
                    unreachable!()
                };
                last.password = password.to_owned();
                vec![first, last]
            })
            .unwrap()
        };
        let first = resolve("first-secret");
        let changed = resolve("changed-secret");
        assert!(first != changed);
        let chain = first.ssh_chains[0].as_ref().unwrap();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[1].host, "db-gateway.example");
        assert_eq!(chain[1].port, 2222);
        assert_eq!(chain[1].password, "first-secret");
    }

    #[test]
    fn resolved_transport_does_not_reresolve_a_frozen_plan() {
        let calls = std::cell::Cell::new(0);
        let layers = [ssh_layer("source", "db-alias", 22)];
        let resolved = ResolvedTransportLayers::resolve_with(&layers, |ssh| {
            calls.set(calls.get() + 1);
            let mut ssh = ssh.clone();
            ssh.host = format!("resolved-{}", calls.get());
            vec![ssh]
        })
        .unwrap();
        let cloned = resolved.clone();
        assert_eq!(cloned.layers()[0].endpoint(), ("resolved-1", 22));
        assert!(cloned == resolved);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn resolved_transport_prefix_reuses_its_frozen_alias_without_changing_the_full_plan() {
        let calls = std::cell::Cell::new(0);
        let layers = [ssh_layer("ssh", "db-alias", 22), proxy_layer("proxy", "proxy.internal", 1080)];
        let resolved = ResolvedTransportLayers::resolve_with(&layers, |ssh| {
            calls.set(calls.get() + 1);
            let mut ssh = ssh.clone();
            ssh.host = "frozen.internal".into();
            vec![ssh]
        })
        .unwrap();
        let prefix = resolved.prefix(1);
        assert_eq!(calls.get(), 1);
        assert_eq!(resolved.layers().len(), 2);
        assert_eq!(prefix.layers().len(), 1);
        assert_eq!(prefix.layers()[0].endpoint(), ("frozen.internal", 22));
        assert!(prefix.ssh_chains[0] == resolved.ssh_chains[0]);
    }

    #[tokio::test]
    async fn resolved_transport_starts_the_same_frozen_ssh_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = std::cell::Cell::new(0);
        let layers = [ssh_layer("source", "unresolved.invalid", 22)];
        let resolved = ResolvedTransportLayers::resolve_with(&layers, |ssh| {
            calls.set(calls.get() + 1);
            let mut ssh = ssh.clone();
            ssh.host = "127.0.0.1".to_owned();
            ssh.port = port;
            vec![ssh]
        })
        .unwrap();
        let ssh = super::TunnelManager::default();
        let proxy = super::ProxyTunnelManager::new();
        let http = super::HttpTunnelManager::new();
        let (started, accepted) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(resolved.start("frozen-transport", "db.internal", 1521, &ssh, &proxy, &http), async {
                let (socket, _) = listener.accept().await.unwrap();
                drop(socket);
                true
            })
        })
        .await
        .unwrap();
        assert!(accepted);
        assert!(started.is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn resolved_transport_rejects_unsupported_proxyjump_before_starting_any_layer() {
        let layers = [proxy_layer("proxy", "proxy.example", 1080), ssh_layer("ssh", "db-alias", 22)];
        let result = ResolvedTransportLayers::resolve_with(&layers, |ssh| vec![ssh.clone(), ssh.clone()]);
        assert!(result.err().unwrap().contains("only supports as the first transport layer"));
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

    #[test]
    fn http_tunnel_must_be_outermost_layer() {
        let layers = vec![
            ssh_layer("ssh-a", "bastion-a", 22),
            http_tunnel_layer("http", "https://dbx.example.com/dbx_tunnel.php"),
        ];

        let err = validate_transport_layers(&layers).unwrap_err();

        assert!(err.contains("HTTP tunnel must be the first transport layer"));
    }

    #[test]
    fn single_ssh_hop_with_config_alias_connects_to_resolved_host_and_port() {
        // RF-001 regression: a single SSH layer whose `host` is a
        // `~/.ssh/config` alias must dial the resolved HostName/Port, not
        // the literal alias string.
        let layers = vec![ssh_layer("ssh-a", "myserver", 22)];

        let planned = plan_transport_layers_with_resolver(&layers, "db.internal", 5432, &[], |ssh| {
            assert_eq!(ssh.host, "myserver");
            let mut resolved = ssh.clone();
            resolved.host = "10.0.0.5".to_string();
            resolved.port = 2222;
            vec![resolved]
        });

        assert_eq!(
            planned,
            vec![PlannedTransportLayer {
                layer_type: PlannedLayerType::Ssh,
                connect_host: "10.0.0.5".to_string(),
                connect_port: 2222,
                remote_host: "db.internal".to_string(),
                remote_port: 5432,
            }]
        );
    }

    #[test]
    fn earlier_hop_forwards_to_resolved_alias_of_next_ssh_hop() {
        // RF-002 regression: when hop N+1 is an SSH layer addressed by a
        // config alias, hop N's forward target must be the resolved
        // HostName/Port, not the literal alias (which the remote host at
        // hop N cannot resolve).
        let layers = vec![ssh_layer("ssh-a", "bastion-a", 22), ssh_layer("ssh-b", "myserver", 22)];

        let planned = plan_transport_layers_with_resolver(&layers, "db.internal", 5432, &[41001], |ssh| {
            let mut resolved = ssh.clone();
            if ssh.host == "myserver" {
                resolved.host = "10.0.0.5".to_string();
                resolved.port = 2222;
            }
            vec![resolved]
        });

        assert_eq!(
            planned,
            vec![
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::Ssh,
                    connect_host: "bastion-a".to_string(),
                    connect_port: 22,
                    remote_host: "10.0.0.5".to_string(),
                    remote_port: 2222,
                },
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::Ssh,
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41001,
                    remote_host: "db.internal".to_string(),
                    remote_port: 5432,
                },
            ]
        );
    }

    #[test]
    fn proxy_jump_chain_dials_first_hop_and_forwards_to_next_layer() {
        // Issue #7706: an SSH layer whose alias resolves to a `ProxyJump`
        // chain must dial the outermost jump first, not the final target.
        let layers = vec![ssh_layer("ssh-a", "target-alias", 22)];

        let planned = plan_transport_layers_with_resolver(&layers, "db.internal", 5432, &[], |ssh| {
            assert_eq!(ssh.host, "target-alias");
            let mut jump = ssh.clone();
            jump.host = "1.1.1.1".to_string();
            jump.port = 22;
            let mut target = ssh.clone();
            target.host = "1.1.1.2".to_string();
            target.port = 2222;
            vec![jump, target]
        });

        assert_eq!(
            planned,
            vec![PlannedTransportLayer {
                layer_type: PlannedLayerType::Ssh,
                connect_host: "1.1.1.1".to_string(),
                connect_port: 22,
                remote_host: "db.internal".to_string(),
                remote_port: 5432,
            }]
        );
    }

    #[test]
    fn http_tunnel_first_layer_targets_next_layer() {
        let layers = vec![
            http_tunnel_layer("http", "https://dbx.example.com/dbx_tunnel.php"),
            ssh_layer("ssh-a", "bastion-a", 22),
        ];

        let planned = plan_transport_layers(&layers, "db.internal", 5432, &[41001, 41002]);

        assert_eq!(
            planned,
            vec![
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::HttpTunnel,
                    connect_host: "".to_string(),
                    connect_port: 0,
                    remote_host: "bastion-a".to_string(),
                    remote_port: 22,
                },
                PlannedTransportLayer {
                    layer_type: PlannedLayerType::Ssh,
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41001,
                    remote_host: "db.internal".to_string(),
                    remote_port: 5432,
                },
            ]
        );
    }
}
