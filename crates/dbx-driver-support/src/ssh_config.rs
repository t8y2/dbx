use std::collections::HashSet;
use std::path::{Path, PathBuf};

use glob::{glob_with, MatchOptions};
use russh::keys::ssh_key::{HashAlg, PublicKey};
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
    /// Every `IdentityFile` for this entry, in config order. `identity_file`
    /// keeps the last one for the one-key consumers that predate this list.
    pub identity_files: Vec<String>,
    /// `IdentitiesOnly yes`: the client may offer only these identities, so
    /// the agent must not be asked for everything it holds.
    pub identities_only: bool,
    /// The `ProxyJump` alias, if any. Only a single hop is parsed (OpenSSH's
    /// comma-separated multi-jump form is not supported); the jump itself
    /// may declare its own `ProxyJump`, which `resolve_ssh_tunnel_chain`
    /// follows recursively.
    pub proxy_jump: Option<String>,
    /// The `ProxyCommand` line, verbatim, used to reach this host instead of
    /// a direct TCP connection. `None` when the block declares none.
    pub proxy_command: Option<String>,
}

/// Reads and parses `~/.ssh/config`, following `Include` directives the way
/// OpenSSH does. Returns an empty list (not an error) if the file does not
/// exist, since that's a normal state for users without an SSH config.
pub fn list_hosts() -> Result<Vec<SshConfigHostEntry>, String> {
    let path = PathBuf::from(expand_tilde("~/.ssh/config"));
    let base_dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(expand_tilde("~/.ssh")));
    let mut loader = SshConfigLoader::new(base_dir);
    loader.load_file(&path, 0, true)?;
    loader.merge_match_entries();
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
///
/// A key-auth request with no `key_path` (the user picked "key" but left the
/// path blank, expecting the usual `~/.ssh/id_*` default) falls back to the
/// first existing default key, the way OpenSSH does. Without this the tunnel
/// builder rejects the empty path with "File path cannot be empty" (#11839).
pub fn resolve_ssh_tunnel_config(ssh: &SshTunnelConfig) -> SshTunnelConfig {
    let resolved = match find_host(&ssh.host) {
        Some(entry) => apply_host_entry(ssh, entry),
        None => ssh.clone(),
    };
    apply_default_identity_file(resolved)
}

/// OpenSSH's default identity files, in its own preference order.
const DEFAULT_IDENTITY_FILE_NAMES: [&str; 4] = ["id_ed25519", "id_ecdsa", "id_ecdsa_sk", "id_rsa"];

/// Fills an empty `key_path` when the connection is set up for key auth, using
/// the first default identity file that exists.
///
/// Only key-based methods are considered: for `password`/`agent`/`none` an
/// empty path is meaningful (there is no key to load), and filling one in would
/// silently change which credential the user asked DBX to use. A path is only
/// supplied when the file is actually present, so a user with no keys still
/// gets the original "no key configured" behavior instead of a path that
/// cannot be read.
fn apply_default_identity_file(ssh: SshTunnelConfig) -> SshTunnelConfig {
    apply_default_identity_file_with(ssh, |candidate| Path::new(&expand_tilde(candidate)).is_file())
}

/// Same as [`apply_default_identity_file`] with an injectable existence probe,
/// so tests do not depend on the developer's real `~/.ssh`.
fn apply_default_identity_file_with(mut ssh: SshTunnelConfig, exists: impl Fn(&str) -> bool) -> SshTunnelConfig {
    if !ssh.key_path.trim().is_empty() {
        return ssh;
    }
    if ssh.auth_method != "key" && ssh.auth_method != "key+password" {
        return ssh;
    }
    if let Some(path) =
        DEFAULT_IDENTITY_FILE_NAMES.iter().map(|name| format!("~/.ssh/{name}")).find(|candidate| exists(candidate))
    {
        ssh.key_path = path;
    }
    ssh
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
        // Same default-key fallback as `resolve_ssh_tunnel_config`, so a host
        // with no `~/.ssh/config` block still gets an identity file.
        return vec![apply_default_identity_file(ssh.clone())];
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
    // Any hop still without a key path (no explicit form value, no
    // `IdentityFile`) falls back to the user's default key. Applied last so an
    // `IdentityFile` from `~/.ssh/config` always wins.
    jump_hops.into_iter().map(apply_default_identity_file).collect()
}

/// Builds a synthetic hop for a `ProxyJump` host. Unlike the leaf host in
/// `ssh`, there's no user-filled form for this host, so its identity comes
/// entirely from `~/.ssh/config` (falling back to the leaf's own settings
/// for anything the config entry doesn't specify).
fn jump_hop_from_entry(leaf: &SshTunnelConfig, entry: SshConfigHostEntry) -> SshTunnelConfig {
    // A jump host that pins its identities in `~/.ssh/config` uses those; one
    // that doesn't keeps inheriting the leaf's selection, the way it already
    // inherits the leaf's agent socket and auth method.
    let ssh_agent_key_fingerprint = if entry.identities_only {
        single_agent_fingerprint(&entry.identity_files).unwrap_or_default()
    } else {
        leaf.ssh_agent_key_fingerprint.clone()
    };
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
        local_port: None,
        use_ssh_agent: leaf.use_ssh_agent,
        ssh_agent_sock_path: leaf.ssh_agent_sock_path.clone(),
        ssh_agent_key_fingerprint,
        auth_method: leaf.auth_method.clone(),
        allow_exec_channel_proxy: leaf.allow_exec_channel_proxy,
        proxy_command: entry.proxy_command.unwrap_or_default(),
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
    // Computed before `entry` is consumed below: `IdentitiesOnly yes` pins the
    // host to the listed identities.
    let config_agent_fingerprint =
        if entry.identities_only { single_agent_fingerprint(&entry.identity_files) } else { None };
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
    // Offering every identity of an agent exhausts a server's per-connection
    // authentication attempts long before the matching key comes up, so when
    // the config pins the identities and the layer authenticates through the
    // agent, select that one key unless the user already picked another.
    if resolved.ssh_agent_key_fingerprint.trim().is_empty()
        && (resolved.use_ssh_agent || resolved.auth_method == "agent")
    {
        if let Some(fingerprint) = config_agent_fingerprint {
            resolved.ssh_agent_key_fingerprint = fingerprint;
        }
    }
    // A ProxyCommand typed into the connection form wins; otherwise inherit
    // the one from the matched `~/.ssh/config` block.
    if resolved.proxy_command.trim().is_empty() {
        if let Some(proxy_command) = entry.proxy_command {
            resolved.proxy_command = proxy_command;
        }
    }

    resolved
}

/// The fingerprint of the one key named by `identity_files`, read from the
/// companion `.pub` files. `None` when no file can be read or the entries name
/// more than one key: in that case the caller keeps the "offer everything"
/// default rather than guessing.
fn single_agent_fingerprint(identity_files: &[String]) -> Option<String> {
    let mut fingerprints: Vec<String> =
        identity_files.iter().filter_map(|path| identity_file_fingerprint(path)).collect();
    fingerprints.sort();
    fingerprints.dedup();
    if fingerprints.len() == 1 {
        fingerprints.pop()
    } else {
        None
    }
}

fn identity_file_fingerprint(path: &str) -> Option<String> {
    let expanded = expand_tilde(path);
    let public_path =
        if expanded.ends_with(".pub") { PathBuf::from(&expanded) } else { PathBuf::from(format!("{expanded}.pub")) };
    let content = std::fs::read_to_string(public_path).ok()?;
    let key = PublicKey::from_openssh(content.trim()).ok()?;
    Some(key.fingerprint(HashAlg::Sha256).to_string())
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
    /// Entries collected from `Match Host` blocks. They are kept apart so a
    /// `Match` block that precedes the real `Host` block cannot shadow it
    /// (the loader resolves aliases first-match-wins), then folded in by
    /// [`SshConfigLoader::merge_match_entries`].
    match_entries: Vec<SshConfigHostEntry>,
    /// Whether directives currently land in `match_entries` instead of
    /// `entries`.
    current_is_match: bool,
    /// Canonical paths already parsed, so include cycles terminate.
    visited: HashSet<PathBuf>,
    /// Directory that relative `Include` patterns resolve against (`~/.ssh`).
    base_dir: PathBuf,
}

impl SshConfigLoader {
    fn new(base_dir: PathBuf) -> Self {
        Self {
            entries: Vec::new(),
            current_aliases: Vec::new(),
            match_entries: Vec::new(),
            current_is_match: false,
            visited: HashSet::new(),
            base_dir,
        }
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
    /// `Match Host`, `HostName`, `Port`, `User`, `IdentityFile`,
    /// `IdentitiesOnly`, `ProxyJump`, `ProxyCommand`, `Include`.
    /// Wildcard host patterns (containing `*` or `?`) are skipped since they
    /// aren't usable as a literal alias in the host field. `Match` blocks with
    /// any criterion other than `Host` (`all`, `User`, `exec`, ...) cannot be
    /// evaluated here and are ignored, as are unknown directives.
    /// `ProxyJump`'s comma-separated multi-hop form is read as a single alias
    /// (its first hop).
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
                        self.entries.push(SshConfigHostEntry::new(alias));
                    }
                    self.current_aliases = aliases;
                    self.current_is_match = false;
                }
                // `Match Host a b` is the conditional twin of `Host`; its
                // directives are collected separately and merged afterwards so
                // an include that precedes the matching `Host` block (1Password
                // writes `Match Host <alias>` + `IdentitiesOnly yes` +
                // `IdentityFile` that way) cannot shadow that block.
                "match" => {
                    self.current_aliases = match_host_aliases(value).unwrap_or_default();
                    for alias in &self.current_aliases {
                        if !self.match_entries.iter().any(|entry| &entry.alias == alias) {
                            self.match_entries.push(SshConfigHostEntry::new(alias));
                        }
                    }
                    self.current_is_match = true;
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
                    entry.identity_files.push(value.to_string());
                }),
                "identitiesonly" => {
                    if let Some(identities_only) = parse_yes_no(value) {
                        self.set_current_field(move |entry| {
                            entry.identities_only = identities_only;
                        });
                    }
                }
                "proxycommand" => self.set_current_field(|entry| {
                    entry.proxy_command = Some(value.to_string());
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
        let entries = if self.current_is_match { &mut self.match_entries } else { &mut self.entries };
        for entry in entries.iter_mut() {
            if aliases.contains(&entry.alias) {
                apply(entry);
            }
        }
    }

    /// Folds `Match Host` blocks into the real entries. Values from the
    /// conditional block only fill fields the `Host` block left unset, so a
    /// `Match` that precedes its `Host` (the 1Password layout) enriches it
    /// instead of replacing its `HostName`/`Port`/`User`.
    fn merge_match_entries(&mut self) {
        for condition in std::mem::take(&mut self.match_entries) {
            match self.entries.iter_mut().find(|entry| entry.alias == condition.alias) {
                Some(entry) => {
                    entry.host_name = entry.host_name.take().or(condition.host_name);
                    entry.port = entry.port.or(condition.port);
                    entry.user = entry.user.take().or(condition.user);
                    entry.proxy_command = entry.proxy_command.take().or(condition.proxy_command);
                    entry.proxy_jump = entry.proxy_jump.take().or(condition.proxy_jump);
                    entry.identities_only |= condition.identities_only;
                    for identity_file in condition.identity_files {
                        if !entry.identity_files.contains(&identity_file) {
                            entry.identity_files.push(identity_file);
                        }
                    }
                    if entry.identity_file.is_none() {
                        entry.identity_file = condition.identity_file;
                    }
                }
                None => self.entries.push(condition),
            }
        }
    }
}

impl SshConfigHostEntry {
    fn new(alias: &str) -> Self {
        Self {
            alias: alias.to_string(),
            host_name: None,
            port: None,
            user: None,
            identity_file: None,
            identity_files: Vec::new(),
            identities_only: false,
            proxy_jump: None,
            proxy_command: None,
        }
    }
}

/// Returns the aliases a `Match` line applies to, or `None` when the block
/// uses a criterion that cannot be evaluated statically (`all`, `User`,
/// `exec`, ...) or names only wildcard hosts.
fn match_host_aliases(value: &str) -> Option<Vec<String>> {
    let mut tokens = value.split_whitespace();
    if !tokens.next()?.eq_ignore_ascii_case("host") {
        return None;
    }
    let aliases: Vec<String> =
        tokens.filter(|alias| !alias.contains('*') && !alias.contains('?')).map(str::to_string).collect();
    (!aliases.is_empty()).then_some(aliases)
}

fn parse_yes_no(value: &str) -> Option<bool> {
    if value.eq_ignore_ascii_case("yes") {
        Some(true)
    } else if value.eq_ignore_ascii_case("no") {
        Some(false)
    } else {
        None
    }
}

/// Parses config text that stands on its own (tests, snippets): `Include` is
/// not followed because there is no file context to resolve it against.
#[cfg(test)]
fn parse_ssh_config(content: &str) -> Vec<SshConfigHostEntry> {
    let mut loader = SshConfigLoader::new(PathBuf::new());
    let _ = loader.parse_lines(content, false, 0);
    loader.merge_match_entries();
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
            local_port: None,
            use_ssh_agent: false,
            ssh_agent_sock_path: String::new(),
            ssh_agent_key_fingerprint: String::new(),
            auth_method: String::new(),
            allow_exec_channel_proxy: false,
            proxy_command: String::new(),
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

    #[test]
    fn parses_proxy_command_verbatim() {
        let entries = parse_ssh_config("Host proxied\n  HostName 10.0.0.5\n  ProxyCommand nc %h %p\n");
        assert_eq!(entries[0].proxy_command, Some("nc %h %p".to_string()));
    }

    #[test]
    fn resolve_inherits_proxy_command_only_when_form_is_empty() {
        let mut ssh = config("myserver");
        let mut source = entry("myserver");
        source.proxy_command = Some("nc %h %p".to_string());

        let inherited = apply_host_entry(&ssh, source.clone());
        assert_eq!(inherited.proxy_command, "nc %h %p");

        ssh.proxy_command = "cloudflared access ssh --hostname %h".to_string();
        let explicit = apply_host_entry(&ssh, source);
        assert_eq!(explicit.proxy_command, "cloudflared access ssh --hostname %h");
    }

    #[test]
    fn jump_hop_carries_its_own_proxy_command() {
        let ssh = config("target");
        let mut gateway = jump_entry("gateway", "1.1.1.1", None);
        gateway.proxy_command = Some("nc %h %p".to_string());
        let entries = [gateway, jump_entry("target", "1.1.1.2", Some("gateway"))];

        let chain = resolve_chain_from_entries(&ssh, &entries);

        assert_eq!(chain[0].proxy_command, "nc %h %p");
        assert_eq!(chain[1].proxy_command, "");
    }

    fn entry(alias: &str) -> SshConfigHostEntry {
        SshConfigHostEntry {
            alias: alias.to_string(),
            host_name: Some("10.0.0.5".to_string()),
            port: Some(2222),
            user: Some("deploy".to_string()),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
            identity_files: vec!["~/.ssh/id_ed25519".to_string()],
            identities_only: false,
            proxy_jump: None,
            proxy_command: None,
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

    // #11839: picking "key" auth without typing a path must fall back to the
    // usual `~/.ssh/id_*` defaults instead of reaching the tunnel builder with
    // an empty path ("File path cannot be empty").
    #[test]
    fn key_auth_without_a_path_falls_back_to_the_existing_default_key() {
        let mut ssh = config("host");
        ssh.auth_method = "key".to_string();
        // No id_ed25519 on this imaginary machine: the next candidate wins.
        let resolved = apply_default_identity_file_with(ssh, |candidate| candidate.ends_with("id_rsa"));
        assert_eq!(resolved.key_path, "~/.ssh/id_rsa");
    }

    #[test]
    fn default_key_fallback_prefers_ed25519_over_rsa() {
        let mut ssh = config("host");
        ssh.auth_method = "key+password".to_string();
        let resolved = apply_default_identity_file_with(ssh, |_| true);
        assert_eq!(resolved.key_path, "~/.ssh/id_ed25519");
    }

    #[test]
    fn default_key_fallback_leaves_non_key_methods_untouched() {
        // Empty is meaningful for these methods; supplying a key path would
        // silently change the credential the user selected.
        for method in ["password", "agent", "none", ""] {
            let mut ssh = config("host");
            ssh.auth_method = method.to_string();
            let resolved = apply_default_identity_file_with(ssh, |_| true);
            assert_eq!(resolved.key_path, "", "method {method:?} must not get a default key");
        }
    }

    #[test]
    fn default_key_fallback_keeps_an_explicit_path() {
        let mut ssh = config("host");
        ssh.auth_method = "key".to_string();
        ssh.key_path = "/explicit/key".to_string();
        let resolved = apply_default_identity_file_with(ssh, |_| true);
        assert_eq!(resolved.key_path, "/explicit/key");
    }

    #[test]
    fn default_key_fallback_is_skipped_when_no_candidate_exists() {
        // A user with no keys keeps the previous behavior (and its clearer
        // error) rather than getting an unreadable path.
        let mut ssh = config("host");
        ssh.auth_method = "key".to_string();
        let resolved = apply_default_identity_file_with(ssh, |_| false);
        assert_eq!(resolved.key_path, "");
    }

    #[test]
    fn an_ssh_config_identity_file_still_wins_over_the_default_key() {
        let mut ssh = config("myserver");
        ssh.auth_method = "key".to_string();
        let mut config_entry = entry("myserver");
        config_entry.identity_file = Some("~/.ssh/config_declared_key".to_string());
        // The config's own IdentityFile is filled first, so the later
        // default-key pass must leave it alone.
        let resolved = apply_default_identity_file_with(apply_host_entry(&ssh, config_entry), |_| true);
        assert_eq!(resolved.key_path, "~/.ssh/config_declared_key");
    }

    fn jump_entry(alias: &str, host_name: &str, proxy_jump: Option<&str>) -> SshConfigHostEntry {
        SshConfigHostEntry {
            alias: alias.to_string(),
            host_name: Some(host_name.to_string()),
            port: None,
            user: None,
            identity_file: None,
            identity_files: Vec::new(),
            identities_only: false,
            proxy_jump: proxy_jump.map(str::to_string),
            proxy_command: None,
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

    #[test]
    fn jump_hop_inherits_the_leaf_agent_key_without_identities_only() {
        let mut leaf = config("target");
        leaf.ssh_agent_key_fingerprint = "SHA256:leaf".to_string();

        let hop = jump_hop_from_entry(&leaf, jump_entry("gateway", "1.1.1.1", None));

        assert_eq!(hop.ssh_agent_key_fingerprint, "SHA256:leaf");
    }

    #[test]
    fn jump_hop_uses_its_own_identities_only_key() {
        let dir = tempfile::TempDir::new().unwrap();
        let public_path = dir.path().join("jump.pub");
        std::fs::write(
            &public_path,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDjAWVPHn2gq7JpSrD5jpUBnnOMn4hB9ieE0UcpM654 fixture-one\n",
        )
        .unwrap();
        let mut leaf = config("target");
        leaf.ssh_agent_key_fingerprint = "SHA256:leaf".to_string();
        let mut gateway = jump_entry("gateway", "1.1.1.1", None);
        gateway.identity_files = vec![public_path.to_string_lossy().into_owned()];
        gateway.identities_only = true;

        let hop = jump_hop_from_entry(&leaf, gateway);

        assert_eq!(hop.ssh_agent_key_fingerprint, "SHA256:6Dkiwer56XB8PoBi8F2PZ7loWKttQNnE8wBhPB34Bd0");
    }

    #[test]
    fn match_host_block_enriches_the_host_block_that_follows_it() {
        let entries = parse_ssh_config(
            "Match Host chanel\n  IdentitiesOnly yes\n  IdentityFile ~/.ssh/1Password/key.pub\n\
             Host chanel\n  HostName 36.133.78.129\n  Port 19022\n  User root\n",
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "chanel");
        assert_eq!(entries[0].host_name.as_deref(), Some("36.133.78.129"));
        assert_eq!(entries[0].port, Some(19022));
        assert_eq!(entries[0].user.as_deref(), Some("root"));
        assert!(entries[0].identities_only);
        assert_eq!(entries[0].identity_files, vec!["~/.ssh/1Password/key.pub"]);
    }

    #[test]
    fn match_block_criteria_that_cannot_be_evaluated_are_ignored() {
        let entries = parse_ssh_config(
            "Match all\n  IdentitiesOnly yes\nHost direct\n  HostName 10.0.0.1\n\
             Match User deploy\n  IdentityFile ~/.ssh/deploy\n",
        );

        assert_eq!(entries.len(), 1);
        assert!(!entries[0].identities_only);
        assert!(entries[0].identity_files.is_empty());
    }

    #[test]
    fn match_host_without_a_host_block_still_resolves() {
        let entries = parse_ssh_config("Match Host solo\n  IdentitiesOnly yes\n  IdentityFile ~/.ssh/solo.pub\n");

        assert_eq!(entries.len(), 1);
        assert!(entries[0].identities_only);
        assert_eq!(entries[0].identity_files, vec!["~/.ssh/solo.pub"]);
    }

    #[test]
    fn identities_only_fills_the_agent_key_from_the_public_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let public_path = dir.path().join("agent.pub");
        std::fs::write(
            &public_path,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDjAWVPHn2gq7JpSrD5jpUBnnOMn4hB9ieE0UcpM654 fixture-one\n",
        )
        .unwrap();

        let mut ssh = config("chanel");
        ssh.auth_method = "agent".to_string();
        ssh.use_ssh_agent = true;
        let mut host = entry("chanel");
        host.identity_file = Some(public_path.to_string_lossy().into_owned());
        host.identity_files = vec![public_path.to_string_lossy().into_owned()];
        host.identities_only = true;

        let resolved = apply_host_entry(&ssh, host);

        assert_eq!(resolved.ssh_agent_key_fingerprint, "SHA256:6Dkiwer56XB8PoBi8F2PZ7loWKttQNnE8wBhPB34Bd0");
    }

    #[test]
    fn identities_only_with_several_keys_or_an_explicit_selection_is_not_guessed() {
        let dir = tempfile::TempDir::new().unwrap();
        let first = dir.path().join("first.pub");
        let second = dir.path().join("second.pub");
        std::fs::write(
            &first,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDjAWVPHn2gq7JpSrD5jpUBnnOMn4hB9ieE0UcpM654 fixture-one\n",
        )
        .unwrap();
        std::fs::write(
            &second,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIISjubSpkMgLWOaYIdP6TfTeRoFA6M1ojv6vyqunJpUb fixture-two\n",
        )
        .unwrap();

        let mut ssh = config("chanel");
        ssh.auth_method = "agent".to_string();
        let mut host = entry("chanel");
        host.identity_files = vec![first.to_string_lossy().into_owned(), second.to_string_lossy().into_owned()];
        host.identities_only = true;
        assert_eq!(apply_host_entry(&ssh, host.clone()).ssh_agent_key_fingerprint, "");

        ssh.ssh_agent_key_fingerprint = "SHA256:explicit".to_string();
        host.identity_files = vec![first.to_string_lossy().into_owned()];
        assert_eq!(apply_host_entry(&ssh, host).ssh_agent_key_fingerprint, "SHA256:explicit");
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
        loader.merge_match_entries();
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
    fn included_match_host_block_applies_to_a_host_block_declared_after_it() {
        // The layout 1Password writes: the generated include is pulled in at
        // the top of ~/.ssh/config, so its `Match Host` block is parsed before
        // the user's own `Host` block for the same alias.
        let dir = TempDir::new().unwrap();
        let main = write_config(
            dir.path(),
            "config",
            "Include 1Password/config\nHost chanel\n  HostName 36.133.78.129\n  Port 19022\n  User root\n",
        );
        write_config(
            dir.path(),
            "1Password/config",
            "Match Host chanel\n  IdentitiesOnly yes\n  IdentityFile ~/.ssh/1Password/SHA256_key.pub\n",
        );

        let entries = hosts_from(&main, dir.path());

        assert_eq!(aliases(&entries), vec!["chanel"]);
        assert_eq!(entries[0].host_name.as_deref(), Some("36.133.78.129"));
        assert_eq!(entries[0].port, Some(19022));
        assert!(entries[0].identities_only);
        assert_eq!(entries[0].identity_files, vec!["~/.ssh/1Password/SHA256_key.pub"]);
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
