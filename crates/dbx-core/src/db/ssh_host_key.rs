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
//!
//! Hardening rules:
//! * A host whose key **changed** (vs. either store) is rejected. This closes
//!   the MITM credential-harvest hole so a password is never sent to an
//!   impostor, and we do not silently fall back to sending credentials.
//! * If an unknown host's key **cannot be persisted** (e.g. no write permission
//!   on `<data_dir>`), `learn` fails — but that failure is surfaced by the
//!   caller, which still refuses to trust the host silently.

use std::io;
use std::path::PathBuf;

use russh::keys::known_hosts::{check_known_hosts, check_known_hosts_path, learn_known_hosts_path};
use russh::keys::ssh_key::PublicKey;

/// Outcome of checking a server key against the known-hosts stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyState {
    /// The key matches a previously trusted entry (system or dbx store).
    Trusted,
    /// The key is not present in either store (candidate for explicit TOFU).
    Unknown,
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

    /// Layered, fail-closed check. A *changed* key (mismatch vs either store)
    /// is reported as an `Err` so the caller aborts the handshake.
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
                return Err(host_key_changed_error(host, port, line, &self.known_hosts_path.display().to_string()));
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
}

fn host_key_changed_error(host: &str, port: u16, line: usize, store: &str) -> io::Error {
    io::Error::other(format!(
        "Host key for {host}:{port} changed (recorded at {store}, line {line}). \
         This may indicate a man-in-the-middle attack. Remove the old entry and reconnect only if you expect this change."
    ))
}
