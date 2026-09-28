use std::collections::HashSet;
use std::path::{Path, PathBuf};

use glob::{glob_with, MatchOptions};
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

/// Reads and parses `~/.ssh/config`, following `Include` directives the way
/// OpenSSH does. Returns an empty list (not an error) if the file does not
/// exist, since that's a normal state for users without an SSH config.
pub fn list_hosts() -> Result<Vec<SshConfigHostEntry>, String> {
    let path = PathBuf::from(expand_tilde("~/.ssh/config"));
    let base_dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(expand_tilde("~/.ssh")));
    let mut loader = SshConfigLoader::new(base_dir);
    loader.load_file(&path, 0, true)?;
    Ok(loader.entries)
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

/// OpenSSH gives up after 16 nested `Include`s; mirror that so a config that
/// includes itself can never recurse without bound.
const MAX_INCLUDE_DEPTH: usize = 16;

/// Accumulates `Host` entries while walking a config file and, in place, the
/// files its `Include` directives pull in — OpenSSH treats an include as text
/// substitution at that exact position, so directive order (and therefore
/// first-match-wins for duplicate aliases) is preserved.
struct SshConfigLoader {
    entries: Vec<SshConfigHostEntry>,
    current_aliases: Vec<String>,
    /// Canonical paths already parsed, so include cycles terminate.
    visited: HashSet<PathBuf>,
    /// Directory that relative `Include` patterns resolve against (`~/.ssh`).
    base_dir: PathBuf,
}

impl SshConfigLoader {
    fn new(base_dir: PathBuf) -> Self {
        Self { entries: Vec::new(), current_aliases: Vec::new(), visited: HashSet::new(), base_dir }
    }

    /// Reads `path` and folds its directives into this loader's entries.
    ///
    /// `strict` propagates read failures (used for the top-level config, where
    /// an unreadable file is a real error); included files follow OpenSSH and
    /// are skipped silently when they are missing or unreadable.
    fn load_file(&mut self, path: &Path, depth: usize, strict: bool) -> Result<(), String> {
        let identity = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if !self.visited.insert(identity) {
            return Ok(());
        }
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => {
                return if strict { Err(format!("Failed to read {}: {err}", path.display())) } else { Ok(()) };
            }
        };
        self.parse_lines(&content, true, depth)
    }

    /// Parses a minimal subset of OpenSSH client config syntax: `Host`,
    /// `HostName`, `Port`, `User`, `IdentityFile`, `ProxyJump`, `Include`.
    /// Wildcard host patterns (containing `*` or `?`) are skipped since they
    /// aren't usable as a literal alias in the host field. `ProxyJump`'s
    /// comma-separated multi-hop form is read as a single alias (its first
    /// hop). Unknown directives are ignored.
    fn parse_lines(&mut self, content: &str, follow_includes: bool, depth: usize) -> Result<(), String> {
        for raw_line in content.lines() {
            let line = strip_comment(raw_line).trim();
            if line.is_empty() {
                continue;
            }
            let Some((keyword, value)) = split_directive(line) else {
                continue;
            };

            if keyword.eq_ignore_ascii_case("include") {
                if follow_includes && depth < MAX_INCLUDE_DEPTH {
                    for included in self.include_paths(value) {
                        self.load_file(&included, depth + 1, false)?;
                    }
                }
                continue;
            }

            match keyword.to_ascii_lowercase().as_str() {
                "host" => {
                    let aliases: Vec<String> = value
                        .split_whitespace()
                        .filter(|alias| !alias.contains('*') && !alias.contains('?'))
                        .map(str::to_string)
                        .collect();
                    for alias in &aliases {
                        self.entries.push(SshConfigHostEntry {
                            alias: alias.clone(),
                            host_name: None,
                            port: None,
                            user: None,
                            identity_file: None,
                            proxy_jump: None,
                        });
                    }
                    self.current_aliases = aliases;
                }
                "hostname" => self.set_current_field(|entry| {
                    entry.host_name = Some(value.to_string());
                }),
                "port" => {
                    if let Ok(port) = value.parse::<u16>() {
                        self.set_current_field(|entry| {
                            entry.port = Some(port);
                        });
                    }
                }
                "user" => self.set_current_field(|entry| {
                    entry.user = Some(value.to_string());
                }),
                "identityfile" => self.set_current_field(|entry| {
                    entry.identity_file = Some(value.to_string());
                }),
                "proxyjump" => {
                    if let Some(first_hop) = value.split(',').next().map(str::trim).filter(|hop| !hop.is_empty()) {
                        // A `user@host:port` jump target names an alias-incompatible
                        // literal host; only a plain alias is resolvable here.
                        if !first_hop.contains('@') && !first_hop.contains(':') {
                            let first_hop = first_hop.to_string();
                            self.set_current_field(|entry| {
                                entry.proxy_jump = Some(first_hop.clone());
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Expands one `Include` line into the files it names, mirroring OpenSSH:
    /// `~` is expanded, relative patterns resolve against `base_dir`, glob
    /// wildcards are honored, and patterns that match nothing (missing files)
    /// are skipped instead of failing the whole config.
    fn include_paths(&self, value: &str) -> Vec<PathBuf> {
        let options = MatchOptions { require_literal_leading_dot: true, ..MatchOptions::default() };
        let mut paths = Vec::new();
        for pattern in value.split_whitespace() {
            let expanded = expand_tilde(pattern);
            let candidate =
                if Path::new(&expanded).is_absolute() { PathBuf::from(expanded) } else { self.base_dir.join(expanded) };
            let Ok(matches) = glob_with(&candidate.to_string_lossy(), options) else {
                continue;
            };
            let mut files: Vec<PathBuf> = matches.filter_map(Result::ok).collect();
            // glob order is filesystem-dependent; sorting keeps host ordering
            // (and therefore duplicate-alias resolution) reproducible.
            files.sort();
            paths.extend(files);
        }
        paths
    }

    fn set_current_field(&mut self, apply: impl Fn(&mut SshConfigHostEntry)) {
        let aliases = self.current_aliases.as_slice();
        for entry in self.entries.iter_mut() {
            if aliases.contains(&entry.alias) {
                apply(entry);
            }
        }
    }
}

/// Parses config text that stands on its own (tests, snippets): `Include` is
/// not followed because there is no file context to resolve it against.
#[cfg(test)]
fn parse_ssh_config(content: &str) -> Vec<SshConfigHostEntry> {
    let mut loader = SshConfigLoader::new(PathBuf::new());
    let _ = loader.parse_lines(content, false, 0);
    loader.entries
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

#[cfg(test)]
mod include_tests {
    use super::*;
    use tempfile::TempDir;

    /// Writes `content` to `dir/relative`, creating parent directories.
    fn write_config(dir: &Path, relative: &str, content: &str) -> PathBuf {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dirs");
        }
        std::fs::write(&path, content).expect("write config file");
        path
    }

    /// Loads `path` with `base_dir` as the include root, exactly like
    /// `list_hosts` does with `~/.ssh`.
    fn hosts_from(path: &Path, base_dir: &Path) -> Vec<SshConfigHostEntry> {
        let mut loader = SshConfigLoader::new(base_dir.to_path_buf());
        loader.load_file(path, 0, true).expect("load config");
        loader.entries
    }

    fn aliases(entries: &[SshConfigHostEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.alias.as_str()).collect()
    }

    #[test]
    fn follows_relative_glob_includes_in_sorted_order() {
        let dir = TempDir::new().unwrap();
        let main = write_config(
            dir.path(),
            "config",
            "Host direct\n  HostName 10.0.0.1\nInclude conf.d/*\nHost local\n  HostName 10.0.0.2\n",
        );
        write_config(
            dir.path(),
            "conf.d/10-proxy.conf",
            "Host abc\n  HostName 10.0.1.1\n  User ops\n  ProxyCommand nc %h %p\n",
        );
        write_config(dir.path(), "conf.d/20-extra.conf", "Host zzz\n  HostName 10.0.1.2\n");

        let entries = hosts_from(&main, dir.path());

        // Includes are substituted in place, so hosts land between `direct`
        // and `local`; glob results are sorted for reproducibility.
        assert_eq!(aliases(&entries), vec!["direct", "abc", "zzz", "local"]);
        let abc = &entries[1];
        assert_eq!(abc.host_name, Some("10.0.1.1".to_string()));
        assert_eq!(abc.user, Some("ops".to_string()));
        // ProxyCommand is not a supported directive (issue #10454 tracks the
        // missing host resolution, not this), so it must not leak into the
        // resolved tunnel config.
        assert_eq!(abc.proxy_jump, None);
    }

    #[test]
    fn include_accepts_absolute_paths_and_multiple_patterns_on_one_line() {
        let dir = TempDir::new().unwrap();
        let sibling = write_config(dir.path(), "elsewhere/absolute.conf", "Host abs\n  HostName 10.0.2.1\n");
        let main = write_config(
            dir.path(),
            "config",
            &format!("Include conf.d/first.conf {}\nHost tail\n  HostName 10.0.2.9\n", sibling.display()),
        );
        write_config(dir.path(), "conf.d/first.conf", "Host rel\n  HostName 10.0.2.2\n");

        let entries = hosts_from(&main, dir.path());

        assert_eq!(aliases(&entries), vec!["rel", "abs", "tail"]);
    }

    #[test]
    fn missing_include_targets_are_skipped_without_failing() {
        let dir = TempDir::new().unwrap();
        let main = write_config(dir.path(), "config", "Include conf.d/*\nHost only\n  HostName 10.0.3.1\n");

        let entries = hosts_from(&main, dir.path());

        assert_eq!(aliases(&entries), vec!["only"]);
    }

    #[test]
    fn nested_includes_are_followed_recursively() {
        let dir = TempDir::new().unwrap();
        let main = write_config(dir.path(), "config", "Include conf.d/50-middle.conf\n");
        write_config(
            dir.path(),
            "conf.d/50-middle.conf",
            "Host middle\n  HostName 10.0.4.1\nInclude nested/60-leaf.conf\n",
        );
        write_config(dir.path(), "nested/60-leaf.conf", "Host leaf\n  HostName 10.0.4.2\n");

        let entries = hosts_from(&main, dir.path());

        assert_eq!(aliases(&entries), vec!["middle", "leaf"]);
    }

    #[test]
    fn include_cycles_terminate() {
        let dir = TempDir::new().unwrap();
        let main = write_config(dir.path(), "config", "Include a.conf\n");
        write_config(dir.path(), "a.conf", "Host a\n  HostName 10.0.5.1\nInclude b.conf\n");
        write_config(dir.path(), "b.conf", "Host b\n  HostName 10.0.5.2\nInclude a.conf\n");

        let entries = hosts_from(&main, dir.path());

        // Each file is parsed once; the cycle back into a.conf is ignored.
        assert_eq!(aliases(&entries), vec!["a", "b"]);
    }

    #[test]
    fn directives_after_an_include_bind_to_the_last_host_it_declared() {
        // OpenSSH treats Include as text substitution at that exact position,
        // so a keyword following it belongs to the most recent Host — which
        // may have been declared inside the included file. Getting this wrong
        // would misattribute values, so lock the behavior down.
        let dir = TempDir::new().unwrap();
        let main = write_config(
            dir.path(),
            "config",
            "Host first\n  HostName 10.0.6.1\nInclude conf.d/inner.conf\n  User shared\n",
        );
        write_config(dir.path(), "conf.d/inner.conf", "Host second\n  HostName 10.0.6.2\n");

        let entries = hosts_from(&main, dir.path());

        assert_eq!(aliases(&entries), vec!["first", "second"]);
        assert_eq!(entries[0].user, None);
        assert_eq!(entries[1].user, Some("shared".to_string()));
    }

    #[test]
    fn host_declared_in_an_included_file_keeps_receiving_later_directives() {
        let dir = TempDir::new().unwrap();
        let main = write_config(dir.path(), "config", "Include conf.d/inner.conf\n  Port 2200\n");
        write_config(dir.path(), "conf.d/inner.conf", "Host included\n  HostName 10.0.7.1\n");

        let entries = hosts_from(&main, dir.path());

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].port, Some(2200));
    }

    #[test]
    fn tilde_prefixed_include_patterns_do_not_break_the_loader() {
        // `~` resolution itself is covered by dbx-platform's path_utils tests;
        // here we only assert the loader tolerates a home-relative pattern
        // (e.g. `~/.ssh/conf.d/*`) that matches nothing on this machine.
        let dir = TempDir::new().unwrap();
        let main = write_config(
            dir.path(),
            "config",
            "Include ~/.ssh/dbx-no-such-dir-xyz/*\nHost kept\n  HostName 10.0.8.1\n",
        );

        let entries = hosts_from(&main, dir.path());

        assert_eq!(aliases(&entries), vec!["kept"]);
    }
}
