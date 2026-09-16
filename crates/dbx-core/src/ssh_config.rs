use serde::Serialize;

use crate::models::connection::SshTunnelConfig;
use crate::path_utils::expand_tilde;

/// Legacy sentinel values used by connection payloads that predate the
/// explicit SSH authentication method field. Current connection forms always
/// set `auth_method`, so their user and port values must be treated as
/// explicit, including the valid defaults `root` and `22`.
const DEFAULT_USER_SENTINEL: &str = "root";
const DEFAULT_PORT_SENTINEL: u16 = 22;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshConfigHostEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    /// The `ProxyJump` alias, if any. Only a single hop is parsed (OpenSSH's
    /// comma-separated multi-jump form is not supported); the jump itself
    /// may declare its own `ProxyJump`, which `resolve_ssh_tunnel_chain`
    /// follows recursively.
    pub proxy_jump: Option<String>,
}

/// Reads and parses `~/.ssh/config`. Returns an empty list (not an error) if
/// the file does not exist, since that's a normal state for users without
/// an SSH config.
pub fn list_hosts() -> Result<Vec<SshConfigHostEntry>, String> {
    let path = expand_tilde("~/.ssh/config");
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(parse_ssh_config(&content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!("Failed to read {path}: {err}")),
    }
}

pub fn find_host(alias: &str) -> Option<SshConfigHostEntry> {
    list_hosts().ok()?.into_iter().find(|entry| entry.alias == alias)
}

/// Fills in `host`, `user`, `port`, and `key_path` from a matching `~/.ssh/config`
/// `Host` block, without overwriting values the user has explicitly set.
///
/// Only `ssh.host` is matched against config aliases; `user`/`port`/`key_path`
/// are filled in from that same matched entry. Older payloads without an
/// `auth_method` retain the legacy default-filling behavior so imported
/// connections continue to resolve their aliases. Payloads produced by the
/// current connection form keep all user and port values as entered.
pub fn resolve_ssh_tunnel_config(ssh: &SshTunnelConfig) -> SshTunnelConfig {
    match find_host(&ssh.host) {
        Some(entry) => apply_host_entry(ssh, entry),
        None => ssh.clone(),
    }
}

/// Resolves `ssh.host` plus, when its `~/.ssh/config` entry (or an ancestor
/// reached by following `ProxyJump`) declares `ProxyJump`, every jump host
/// leading to it. The returned list is in connection order — outermost jump
/// first, `ssh`'s own resolved config last — and always has at least one
/// element. A chain of length 1 means there is no `ProxyJump` to honor, and
/// behaves exactly like [`resolve_ssh_tunnel_config`].
///
/// Jump hosts have no dedicated credentials field in DBX's connection form,
/// so each one inherits `ssh`'s password/key/agent settings; only the
/// host/port/user/identity file come from its own `~/.ssh/config` entry.
pub fn resolve_ssh_tunnel_chain(ssh: &SshTunnelConfig) -> Vec<SshTunnelConfig> {
    resolve_chain_from_entries(ssh, &list_hosts().unwrap_or_default())
}

fn resolve_chain_from_entries(ssh: &SshTunnelConfig, entries: &[SshConfigHostEntry]) -> Vec<SshTunnelConfig> {
    let find = |alias: &str| entries.iter().find(|entry| entry.alias == alias).cloned();

    let Some(target_entry) = find(&ssh.host) else {
        return vec![ssh.clone()];
    };
    let resolved_target = apply_host_entry(ssh, target_entry.clone());

    let mut jump_hops = Vec::new();
    let mut seen_aliases = std::collections::HashSet::new();
    seen_aliases.insert(ssh.host.clone());
    let mut next_jump = target_entry.proxy_jump.clone();
    while let Some(alias) = next_jump {
        // Guard against a cycle in `~/.ssh/config` (e.g. two hosts naming
        // each other as ProxyJump) rather than looping forever.
        if !seen_aliases.insert(alias.clone()) {
            break;
        }
        let Some(entry) = find(&alias) else { break };
        next_jump = entry.proxy_jump.clone();
        jump_hops.push(jump_hop_from_entry(ssh, entry));
    }

    jump_hops.reverse();
    jump_hops.push(resolved_target);
    jump_hops
}

/// Builds a synthetic hop for a `ProxyJump` host. Unlike the leaf host in
/// `ssh`, there's no user-filled form for this host, so its identity comes
/// entirely from `~/.ssh/config` (falling back to the leaf's own settings
/// for anything the config entry doesn't specify).
fn jump_hop_from_entry(leaf: &SshTunnelConfig, entry: SshConfigHostEntry) -> SshTunnelConfig {
    SshTunnelConfig {
        id: format!("{}::proxyjump::{}", leaf.id, entry.alias),
        name: entry.alias.clone(),
        enabled: true,
        host: entry.host_name.unwrap_or_else(|| entry.alias.clone()),
        port: entry.port.unwrap_or(DEFAULT_PORT_SENTINEL),
        user: entry.user.unwrap_or_else(|| leaf.user.clone()),
        password: leaf.password.clone(),
        key_path: entry.identity_file.unwrap_or_else(|| leaf.key_path.clone()),
        key_passphrase: leaf.key_passphrase.clone(),
        connect_timeout_secs: leaf.connect_timeout_secs,
        expose_lan: false,
        use_ssh_agent: leaf.use_ssh_agent,
        ssh_agent_sock_path: leaf.ssh_agent_sock_path.clone(),
        auth_method: leaf.auth_method.clone(),
        allow_exec_channel_proxy: leaf.allow_exec_channel_proxy,
        profile_id: String::new(),
    }
}

/// Applies a resolved `~/.ssh/config` entry onto `ssh`, without overwriting
/// values the user has explicitly set. The empty `auth_method` identifies
/// legacy payloads where default values cannot be distinguished from fields
/// that were left blank in the old form.
fn apply_host_entry(ssh: &SshTunnelConfig, entry: SshConfigHostEntry) -> SshTunnelConfig {
    let mut resolved = ssh.clone();
    let is_legacy_payload = ssh.auth_method.is_empty();

    if let Some(host_name) = entry.host_name {
        resolved.host = host_name;
    }
    if is_legacy_payload && resolved.user == DEFAULT_USER_SENTINEL {
        if let Some(user) = entry.user {
            resolved.user = user;
        }
    }
    if is_legacy_payload && resolved.port == DEFAULT_PORT_SENTINEL {
        if let Some(port) = entry.port {
            resolved.port = port;
        }
    }
    if resolved.key_path.is_empty() {
        if let Some(identity_file) = entry.identity_file {
            resolved.key_path = identity_file;
            // If the SSH config supplied the only usable credential, make the
            // backend use it even when an older/default UI payload still says
            // "password" with an empty password.
            if resolved.auth_method.is_empty() || (resolved.auth_method == "password" && resolved.password.is_empty()) {
                resolved.auth_method = "key".to_string();
            }
        }
    }

    resolved
}

/// Parses a minimal subset of OpenSSH client config syntax: `Host`, `HostName`,
/// `Port`, `User`, `IdentityFile`, `ProxyJump`. Wildcard host patterns
/// (containing `*` or `?`) are skipped since they aren't usable as a literal
/// alias in the host field. `Include` and other directives are not
/// supported, and `ProxyJump`'s comma-separated multi-hop form is read as a
/// single alias (its first hop).
fn parse_ssh_config(content: &str) -> Vec<SshConfigHostEntry> {
    let mut entries: Vec<SshConfigHostEntry> = Vec::new();
    let mut current_aliases: Vec<String> = Vec::new();

    for raw_line in content.lines() {
        let line = strip_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        let Some((keyword, value)) = split_directive(line) else {
            continue;
        };

        match keyword.to_ascii_lowercase().as_str() {
            "host" => {
                current_aliases = value
                    .split_whitespace()
                    .filter(|alias| !alias.contains('*') && !alias.contains('?'))
                    .map(str::to_string)
                    .collect();
                for alias in &current_aliases {
                    entries.push(SshConfigHostEntry {
                        alias: alias.clone(),
                        host_name: None,
                        port: None,
                        user: None,
                        identity_file: None,
                        proxy_jump: None,
                    });
                }
            }
            "hostname" => set_current_field(&mut entries, &current_aliases, |entry| {
                entry.host_name = Some(value.to_string());
            }),
            "port" => {
                if let Ok(port) = value.parse::<u16>() {
                    set_current_field(&mut entries, &current_aliases, |entry| {
                        entry.port = Some(port);
                    });
                }
            }
            "user" => set_current_field(&mut entries, &current_aliases, |entry| {
                entry.user = Some(value.to_string());
            }),
            "identityfile" => set_current_field(&mut entries, &current_aliases, |entry| {
                entry.identity_file = Some(value.to_string());
            }),
            "proxyjump" => {
                if let Some(first_hop) = value.split(',').next().map(str::trim).filter(|hop| !hop.is_empty()) {
                    // A `user@host:port` jump target names an alias-incompatible
                    // literal host; only a plain alias is resolvable here.
                    if !first_hop.contains('@') && !first_hop.contains(':') {
                        let first_hop = first_hop.to_string();
                        set_current_field(&mut entries, &current_aliases, |entry| {
                            entry.proxy_jump = Some(first_hop.clone());
                        });
                    }
                }
            }
            _ => {}
        }
    }

    entries
}

fn set_current_field(
    entries: &mut [SshConfigHostEntry],
    current_aliases: &[String],
    apply: impl Fn(&mut SshConfigHostEntry),
) {
    for entry in entries.iter_mut() {
        if current_aliases.contains(&entry.alias) {
            apply(entry);
        }
    }
}

fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(index) => &line[..index],
        None => line,
    }
}

/// Splits a config line into `(keyword, value)`. OpenSSH allows the keyword
/// and value to be separated by whitespace or a single `=`.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let split_index = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let keyword = &line[..split_index];
    let value = line[split_index..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
    if keyword.is_empty() || value.is_empty() {
        return None;
    }
    Some((keyword, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(host: &str) -> SshTunnelConfig {
        SshTunnelConfig {
            profile_id: String::new(),
            id: "1".to_string(),
            name: String::new(),
            enabled: true,
            host: host.to_string(),
            port: DEFAULT_PORT_SENTINEL,
            user: DEFAULT_USER_SENTINEL.to_string(),
            password: String::new(),
            key_path: String::new(),
            key_passphrase: String::new(),
            connect_timeout_secs: 5,
            expose_lan: false,
            use_ssh_agent: false,
            ssh_agent_sock_path: String::new(),
            auth_method: String::new(),
            allow_exec_channel_proxy: false,
        }
    }

    #[test]
    fn parses_basic_host_block() {
        let entries = parse_ssh_config(
            "Host myserver\n  HostName 10.0.0.5\n  Port 2222\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n",
        );
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.alias, "myserver");
        assert_eq!(entry.host_name, Some("10.0.0.5".to_string()));
        assert_eq!(entry.port, Some(2222));
        assert_eq!(entry.user, Some("deploy".to_string()));
        assert_eq!(entry.identity_file, Some("~/.ssh/id_ed25519".to_string()));
    }

    #[test]
    fn one_line_can_declare_multiple_aliases() {
        let entries = parse_ssh_config("Host prod prod-alias\n  HostName 10.0.0.9\n");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.host_name == Some("10.0.0.9".to_string())));
        assert_eq!(entries[0].alias, "prod");
        assert_eq!(entries[1].alias, "prod-alias");
    }

    #[test]
    fn skips_wildcard_host_patterns() {
        let entries = parse_ssh_config("Host *.example.com\n  User git\nHost real\n  User deploy\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "real");
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let entries = parse_ssh_config("# a comment\n\nHost myserver # inline comment\n  User deploy\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].user, Some("deploy".to_string()));
    }

    #[test]
    fn parses_proxy_jump() {
        let entries = parse_ssh_config("Host target\n  HostName 1.1.1.2\n  ProxyJump gateway\n");
        assert_eq!(entries[0].proxy_jump, Some("gateway".to_string()));
    }

    #[test]
    fn proxy_jump_multi_hop_form_reads_only_the_first_hop() {
        let entries = parse_ssh_config("Host target\n  ProxyJump gw1,gw2\n");
        assert_eq!(entries[0].proxy_jump, Some("gw1".to_string()));
    }

    #[test]
    fn proxy_jump_user_at_host_form_is_not_resolvable_as_an_alias() {
        let entries = parse_ssh_config("Host target\n  ProxyJump jumper@1.1.1.1\n");
        assert_eq!(entries[0].proxy_jump, None);
    }

    fn entry(alias: &str) -> SshConfigHostEntry {
        SshConfigHostEntry {
            alias: alias.to_string(),
            host_name: Some("10.0.0.5".to_string()),
            port: Some(2222),
            user: Some("deploy".to_string()),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
            proxy_jump: None,
        }
    }

    #[test]
    fn resolve_fills_unset_fields_from_matching_alias() {
        let ssh = config("myserver");
        let resolved = apply_host_entry(&ssh, entry("myserver"));
        assert_eq!(resolved.host, "10.0.0.5");
        assert_eq!(resolved.port, 2222);
        assert_eq!(resolved.user, "deploy");
        assert_eq!(resolved.key_path, "~/.ssh/id_ed25519");
        assert_eq!(resolved.auth_method, "key");
    }

    #[test]
    fn resolve_keeps_password_auth_when_password_is_present() {
        let mut ssh = config("myserver");
        ssh.password = "secret".to_string();
        ssh.auth_method = "password".to_string();
        let resolved = apply_host_entry(&ssh, entry("myserver"));
        assert_eq!(resolved.key_path, "~/.ssh/id_ed25519");
        assert_eq!(resolved.auth_method, "password");
    }

    #[test]
    fn resolve_keeps_default_user_and_port_for_current_payloads() {
        let mut ssh = config("myserver");
        ssh.auth_method = "password".to_string();

        let resolved = apply_host_entry(&ssh, entry("myserver"));

        assert_eq!(resolved.host, "10.0.0.5");
        assert_eq!(resolved.user, DEFAULT_USER_SENTINEL);
        assert_eq!(resolved.port, DEFAULT_PORT_SENTINEL);
    }

    #[test]
    fn resolve_preserves_key_plus_password_method() {
        let mut ssh = config("myserver");
        ssh.auth_method = "key+password".to_string();
        ssh.password = "secret".to_string();
        let resolved = apply_host_entry(&ssh, entry("myserver"));
        assert_eq!(resolved.key_path, "~/.ssh/id_ed25519");
        assert_eq!(resolved.auth_method, "key+password");
    }

    #[test]
    fn resolve_does_not_override_explicit_values() {
        let mut ssh = config("myserver");
        ssh.user = "alice".to_string();
        ssh.port = 9999;
        ssh.key_path = "/explicit/key".to_string();
        let resolved = apply_host_entry(&ssh, entry("myserver"));
        assert_eq!(resolved.host, "10.0.0.5");
        assert_eq!(resolved.user, "alice");
        assert_eq!(resolved.port, 9999);
        assert_eq!(resolved.key_path, "/explicit/key");
    }

    #[test]
    fn resolve_is_noop_when_host_does_not_match_any_alias() {
        // `resolve_ssh_tunnel_config` looks up the real `~/.ssh/config`; an
        // alias this unlikely to exist on a test machine exercises the
        // "no match found" branch without needing to mock the filesystem.
        let ssh = config("dbx-test-alias-that-should-never-exist-anywhere");
        let resolved = resolve_ssh_tunnel_config(&ssh);
        assert_eq!(resolved, ssh);
    }

    fn jump_entry(alias: &str, host_name: &str, proxy_jump: Option<&str>) -> SshConfigHostEntry {
        SshConfigHostEntry {
            alias: alias.to_string(),
            host_name: Some(host_name.to_string()),
            port: None,
            user: None,
            identity_file: None,
            proxy_jump: proxy_jump.map(str::to_string),
        }
    }

    #[test]
    fn chain_is_single_hop_without_proxy_jump() {
        let ssh = config("myserver");
        let chain = resolve_chain_from_entries(&ssh, std::slice::from_ref(&entry("myserver")));
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].host, "10.0.0.5");
    }

    #[test]
    fn chain_prepends_the_proxy_jump_hop_in_connection_order() {
        // Mirrors issue #7706: `target` (ProxyJump gateway) resolves to
        // [gateway, target], gateway dialed first.
        let ssh = config("target");
        let entries = [jump_entry("gateway", "1.1.1.1", None), jump_entry("target", "1.1.1.2", Some("gateway"))];

        let chain = resolve_chain_from_entries(&ssh, &entries);

        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].host, "1.1.1.1");
        assert_eq!(chain[0].name, "gateway");
        assert_eq!(chain[1].host, "1.1.1.2");
    }

    #[test]
    fn chain_jump_hop_inherits_leaf_credentials_when_config_has_no_identity_file() {
        let mut ssh = config("target");
        ssh.auth_method = "key".to_string();
        ssh.key_path = "/home/user/.ssh/id_rsa".to_string();
        let entries = [jump_entry("gateway", "1.1.1.1", None), jump_entry("target", "1.1.1.2", Some("gateway"))];

        let chain = resolve_chain_from_entries(&ssh, &entries);

        assert_eq!(chain[0].auth_method, "key");
        assert_eq!(chain[0].key_path, "/home/user/.ssh/id_rsa");
    }

    #[test]
    fn chain_follows_multiple_proxy_jump_hops_recursively() {
        let ssh = config("target");
        let entries = [
            jump_entry("gateway-outer", "1.1.1.1", None),
            jump_entry("gateway-inner", "1.1.1.2", Some("gateway-outer")),
            jump_entry("target", "1.1.1.3", Some("gateway-inner")),
        ];

        let chain = resolve_chain_from_entries(&ssh, &entries);

        assert_eq!(
            chain.iter().map(|hop| hop.host.as_str()).collect::<Vec<_>>(),
            vec!["1.1.1.1", "1.1.1.2", "1.1.1.3"]
        );
    }

    #[test]
    fn chain_breaks_a_proxy_jump_cycle_instead_of_looping_forever() {
        let ssh = config("a");
        let entries = [jump_entry("a", "1.1.1.1", Some("b")), jump_entry("b", "1.1.1.2", Some("a"))];

        let chain = resolve_chain_from_entries(&ssh, &entries);

        // Must terminate; the exact truncation point is an implementation
        // detail of cycle detection, not a behavior callers rely on.
        assert!(chain.len() <= entries.len());
        assert_eq!(chain.last().unwrap().host, "1.1.1.1");
    }
}
