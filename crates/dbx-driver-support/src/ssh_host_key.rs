//! Host-key verification for the SSH tunnel client.
//!
//! Before any credential is sent, russh invokes
//! [`russh::client::Handler::check_server_key`]. The original implementation
//! accepted *every* server key, which let a man-in-the-middle endpoint reject
//! the public key and trick the client into sending the password instead.
//! This module makes that callback actually verify the server identity.
//!
//! Design
//! ------
//! Verification is layered and **fail-closed**, reusing russh's own OpenSSH-
//! format `known_hosts` module instead of a hand-rolled store:
//!
//! 1. The user's system `~/.ssh/known_hosts` is checked **read-only**. Reusing
//!    it means a host already trusted in a terminal is also trusted here, and a
//!    key change recorded there is detected here too. dbx never *writes* to it.
//! 2. dbx's own store at `<data_dir>/known_hosts` (OpenSSH format, managed by
//!    russh's `known_hosts` module) is checked. This is where dbx-accepted host
//!    keys live — NOT `~/.ssh` — so we never pollute the user's SSH config.
//! 3. An unknown host is reported as [`HostKeyState::Unknown`]; the caller
//!    (the `check_server_key` handler) then performs an **explicit TOFU** flow:
//!    it asks the UI to confirm the key and, on acceptance, records it via
//!    [`HostKeyVerifier::learn`].
//! 4. A *changed* key in the dbx store is [`HostKeyState::Changed`]. The caller
//!    prompts the user to compare fingerprints and, if they choose to update,
//!    replaces the old entry via [`HostKeyVerifier::replace`]. A changed key
//!    in `~/.ssh/known_hosts` stays a hard reject — dbx does not edit that file.
//!
//! Hardening rules:
//! * A changed key is never trusted silently. Credentials are sent only after
//!   the user explicitly continues (session-only) or updates the saved key.
//! * If an unknown host's key **cannot be persisted** (e.g. no write permission
//!   on `<data_dir>`), `learn` fails — but that failure is surfaced by the
//!   caller, which still refuses to trust the host silently.

use std::io;
use std::path::{Path, PathBuf};

use russh::keys::known_hosts::{
    check_known_hosts, check_known_hosts_path, known_host_keys_path, learn_known_hosts_path,
};
use russh::keys::parse_public_key_base64;
use russh::keys::ssh_key::{HashAlg, PublicKey};

/// Outcome of checking a server key against the known-hosts stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyState {
    /// The key matches a previously trusted entry (system or dbx store).
    Trusted,
    /// The key is not present in either store (candidate for explicit TOFU).
    Unknown,
    /// The dbx store has a different key of the same algorithm. The caller
    /// should prompt before replacing it; `previous_fingerprint` is the saved
    /// SHA256 fingerprint (or a fallback locator if the line could not be parsed).
    Changed { previous_fingerprint: String },
}

/// Host-key verifier backed by russh's OpenSSH-format known-hosts store.
///
/// `known_hosts_path` is the dbx-managed store (typically
/// `<data_dir>/known_hosts`). The system `~/.ssh/known_hosts` is also consulted
/// read-only via [`check_known_hosts`].
pub struct HostKeyVerifier {
    known_hosts_path: PathBuf,
}

impl HostKeyVerifier {
    /// Creates a verifier that records/reads accepted host keys at `known_hosts_path`.
    pub fn new(known_hosts_path: PathBuf) -> Self {
        Self { known_hosts_path }
    }

    /// Layered, fail-closed check. A *changed* key in `~/.ssh` is an `Err`. A
    /// changed key in the dbx store is [`HostKeyState::Changed`] so the UI can
    /// offer a one-click replace.
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> Result<HostKeyState, io::Error> {
        // 1. System known_hosts (read-only). A changed key there is a hard reject.
        match check_known_hosts(host, port, key) {
            Ok(true) => return Ok(HostKeyState::Trusted),
            Err(russh::keys::Error::KeyChanged { line }) => {
                return Err(host_key_changed_error(host, port, line, "~/.ssh/known_hosts"));
            }
            // Missing system file, no home dir, or an unreadable system file:
            // don't fail the whole connection on it; fall through to the dbx
            // store / TOFU, which still protects against MITM.
            _ => {}
        }

        // 2. dbx-managed known_hosts.
        match check_known_hosts_path(host, port, key, &self.known_hosts_path) {
            Ok(true) => return Ok(HostKeyState::Trusted),
            Err(russh::keys::Error::KeyChanged { line }) => {
                let previous_fingerprint = previous_fingerprint_for(&self.known_hosts_path, host, port, key)
                    .unwrap_or_else(|| format!("(known_hosts line {line})"));
                return Ok(HostKeyState::Changed { previous_fingerprint });
            }
            // Unknown (or an unreadable dbx store): report as a candidate for TOFU.
            _ => {}
        }

        Ok(HostKeyState::Unknown)
    }

    /// Records a host key into the dbx store (TOFU persistence). Called by the
    /// caller only after the user explicitly accepts the key. A write failure
    /// is reported (so the caller knows persistence did not happen) but does
    /// not by itself abort the session — the host may simply be trusted for
    /// this session only.
    pub fn learn(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), io::Error> {
        learn_known_hosts_path(host, port, key, &self.known_hosts_path).map_err(|e| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "Failed to persist host key for {host}:{port} to {} ({e}). \
                     The host is trusted for this session only.",
                    self.known_hosts_path.display()
                ),
            )
        })
    }

    /// Drops the previous same-algorithm key for this host in the dbx store,
    /// then records `key`. Used after the user confirms a fingerprint change.
    pub fn replace(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), io::Error> {
        self.forget_matching_algorithm(host, port, key)?;
        self.learn(host, port, key)
    }

    fn forget_matching_algorithm(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), io::Error> {
        let recorded = match known_host_keys_path(host, port, &self.known_hosts_path) {
            Ok(keys) => keys,
            Err(_) => return Ok(()),
        };
        let drop_keys: Vec<PublicKey> = recorded
            .into_iter()
            .filter(|(_, recorded)| recorded.algorithm() == key.algorithm())
            .map(|(_, recorded)| recorded)
            .collect();
        if drop_keys.is_empty() {
            return Ok(());
        }

        let contents = match std::fs::read_to_string(&self.known_hosts_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut kept = Vec::new();
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                kept.push(line);
                continue;
            }
            let should_drop = trimmed
                .split_whitespace()
                .nth(2)
                .and_then(|encoded| parse_public_key_base64(encoded).ok())
                .map(|parsed| drop_keys.iter().any(|recorded| recorded == &parsed))
                .unwrap_or(false);
            if !should_drop {
                kept.push(line);
            }
        }
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        std::fs::write(&self.known_hosts_path, out)
    }
}

fn previous_fingerprint_for(path: &Path, host: &str, port: u16, key: &PublicKey) -> Option<String> {
    let recorded = known_host_keys_path(host, port, path).ok()?;
    recorded
        .into_iter()
        .find(|(_, recorded)| recorded.algorithm() == key.algorithm() && recorded != key)
        .map(|(_, recorded)| recorded.fingerprint(HashAlg::Sha256).to_string())
}

fn host_key_changed_error(host: &str, port: u16, line: usize, store: &str) -> io::Error {
    io::Error::other(format!(
        "Host key for {host}:{port} changed (recorded at {store}, line {line}). \
         This may indicate a man-in-the-middle attack. Remove the old entry and reconnect only if you expect this change."
    ))
}
