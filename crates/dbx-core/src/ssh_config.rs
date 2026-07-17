use serde::Serialize;

use crate::models::connection::SshTunnelConfig;
use crate::path_utils::expand_tilde;

/// Sentinel values the frontend fills in when the user leaves a field blank
/// (see `normalizeSshTunnel` / `defaultSshTunnel` in ConnectionDialog.vue).
/// There is no way to distinguish "user explicitly typed 22" from "field was
/// left empty and defaulted to 22", so we treat these as "unset" for the
/// purpose of filling in values from `~/.ssh/config`.
const DEFAULT_USER_SENTINEL: &str = "root";
const DEFAULT_PORT_SENTINEL: u16 = 22;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshConfigHostEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
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
/// are filled in from that same matched entry. Values already present on
/// `ssh` win, except for `user`/`port` which use the sentinel defaults above
/// to detect "not actually set by the user".
pub fn resolve_ssh_tunnel_config(ssh: &SshTunnelConfig) -> SshTunnelConfig {
    match find_host(&ssh.host) {
        Some(entry) => apply_host_entry(ssh, entry),
        None => ssh.clone(),
    }
}

/// Applies a resolved `~/.ssh/config` entry onto `ssh`, without overwriting
/// values the user has explicitly set. `user`/`port` use the sentinel
/// defaults above to detect "not actually set by the user".
fn apply_host_entry(ssh: &SshTunnelConfig, entry: SshConfigHostEntry) -> SshTunnelConfig {
    let mut resolved = ssh.clone();

    if let Some(host_name) = entry.host_name {
        resolved.host = host_name;
    }
    if resolved.user == DEFAULT_USER_SENTINEL {
        if let Some(user) = entry.user {
            resolved.user = user;
        }
    }
    if resolved.port == DEFAULT_PORT_SENTINEL {
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
/// `Port`, `User`, `IdentityFile`. Wildcard host patterns (containing `*` or
/// `?`) are skipped since they aren't usable as a literal alias in the host
/// field. `Include` and other directives are not supported.
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
            auth_method: "password".to_string(),
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

    fn entry(alias: &str) -> SshConfigHostEntry {
        SshConfigHostEntry {
            alias: alias.to_string(),
            host_name: Some("10.0.0.5".to_string()),
            port: Some(2222),
            user: Some("deploy".to_string()),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
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
        let resolved = apply_host_entry(&ssh, entry("myserver"));
        assert_eq!(resolved.key_path, "~/.ssh/id_ed25519");
        assert_eq!(resolved.auth_method, "password");
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
}
