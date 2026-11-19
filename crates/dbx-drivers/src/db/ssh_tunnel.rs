use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::path_utils::expand_tilde;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh::client::{self, AuthResult, Config, GexParams, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{decode_secret_key, key::PrivateKeyWithHashAlg, PrivateKey};
use russh::MethodKind;
use russh::MethodSet;
use russh::{cipher, kex, mac, ChannelOpenFailure, Preferred};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use tokio_util::task::AbortOnDropHandle;

#[cfg(test)]
tokio::task_local! {
    static SPAWNED_TUNNELS: mpsc::UnboundedSender<(u16, tokio::task::AbortHandle)>;
}

use crate::db::ssh_host_key::{HostKeyState, HostKeyVerifier};
use crate::db::ssh_prompt;
use crate::models::connection::SshTunnelConfig;

use super::file_validator::validate_file_path;

/// Initial delay between SSH reconnect attempts.
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// Maximum delay for exponential backoff.
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
/// Maximum number of consecutive reconnect attempts before giving up.
const MAX_RECONNECT_ATTEMPTS: u32 = 10;
/// How often an idle local listener verifies that the SSH session still answers.
const IDLE_SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// Maximum time to wait for an explicit SSH ping response.
const IDLE_SESSION_PING_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum time to wait for the UI to answer a host-key verification prompt
/// (explicit TOFU). Fail-closed: if the UI does not answer in time, the host
/// is rejected and no credential is sent.
const TOFU_PROMPT_TIMEOUT: Duration = Duration::from_secs(300);
/// Maximum time to wait for the user to answer one keyboard-interactive
/// challenge (for example a TOTP code).
const KEYBOARD_INTERACTIVE_PROMPT_TIMEOUT: Duration = Duration::from_secs(300);
/// Minimum budget for ssh-agent authentication. A local agent (1Password,
/// Secretive, ...) can hold a sign request until the user approves it in a
/// dialog or with Touch ID, which takes far longer than a TCP handshake.
const SSH_AGENT_AUTH_TIMEOUT_SECS: u64 = 60;

/// SSH client handler. Holds a host-key verifier so that
/// [`client::Handler::check_server_key`] can reject untrusted/changed server
/// keys *before* any credential is sent.
pub struct SshClient {
    host_key_verifier: Arc<HostKeyVerifier>,
    host: String,
    port: u16,
    /// Signaled once an interactive TOFU prompt actually starts waiting on
    /// the user, so the caller can stop charging that think-time against
    /// its short network-level connect timeout (see `connect_and_authenticate`).
    prompt_started_tx: Option<mpsc::Sender<Instant>>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Runs *before any credential authentication*. We first check the
        // known-hosts stores (system + dbx-managed). A trusted key is accepted
        // immediately; an unknown key triggers explicit TOFU; a changed key in
        // the dbx store prompts for replace-or-session-only; a changed key in
        // ~/.ssh/known_hosts is still a hard reject (dbx never writes that file).
        match self.host_key_verifier.check(&self.host, self.port, server_public_key) {
            Ok(HostKeyState::Trusted) => Ok(true),
            Ok(HostKeyState::Unknown) => self.prompt_for_host_key(server_public_key, None).await,
            Ok(HostKeyState::Changed { previous_fingerprint }) => {
                self.prompt_for_host_key(server_public_key, Some(previous_fingerprint)).await
            }
            Err(e) => {
                // Changed host key in ~/.ssh/known_hosts => possible MITM. dbx
                // never writes that file, so surface a notice and fail closed.
                let msg = e.to_string();
                let _ =
                    ssh_prompt::notify_host_key(ssh_prompt::SshHostKeyNoticeKind::Changed, &self.host, self.port, &msg);
                Err(russh::Error::from(e))
            }
        }
    }
}

impl SshClient {
    /// Explicit TOFU: ask the UI to confirm an unknown host key. Fail-closed:
    /// if no gateway is installed, or the user rejects, or the prompt times
    /// out, the host is not trusted and the handshake is aborted — so no
    /// credential is ever sent to an unverified endpoint.
    async fn prompt_for_host_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
        previous_fingerprint: Option<String>,
    ) -> Result<bool, russh::Error> {
        let key_type = Some(server_public_key.algorithm().to_string());
        let fingerprint = Some(server_public_key.fingerprint(HashAlg::Sha256).to_string());
        let replace = previous_fingerprint.is_some();
        let request = if replace {
            ssh_prompt::host_key_changed_request(&self.host, self.port, key_type, fingerprint, previous_fingerprint)
        } else {
            ssh_prompt::host_key_verify_request(&self.host, self.port, key_type, fingerprint)
        };

        let Some(responder_rx) = ssh_prompt::request_ssh_prompt(request) else {
            log::warn!(
                "No SSH prompt gateway installed; refusing to trust unknown host {}:{} (fail-closed)",
                self.host,
                self.port
            );
            return Ok(false);
        };

        // From this point we are genuinely waiting on the user, not the
        // network -- tell the caller so it can stop enforcing its short
        // network-level connect timeout for the remainder of the handshake.
        if let Some(tx) = &self.prompt_started_tx {
            let _ = tx.try_send(Instant::now());
        }

        let answer = tokio::time::timeout(TOFU_PROMPT_TIMEOUT, responder_rx).await;
        match answer {
            Ok(Ok(ssh_prompt::SshPromptAnswer::Accept { remember })) => {
                if remember {
                    let persist = if replace {
                        self.host_key_verifier.replace(&self.host, self.port, server_public_key)
                    } else {
                        self.host_key_verifier.learn(&self.host, self.port, server_public_key)
                    };
                    if let Err(e) = persist {
                        // Persistence failure does not by itself abort the
                        // session — the host is simply trusted for this session
                        // only. Still log it AND surface a notice so the UI can
                        // warn the user (otherwise they will be silently
                        // re-prompted on next connect with no explanation).
                        let detail =
                            format!("Could not persist host key for {}:{} to known_hosts: {e}", self.host, self.port);
                        log::warn!("{detail}");
                        let _ = ssh_prompt::notify_host_key(
                            ssh_prompt::SshHostKeyNoticeKind::LearnFailed,
                            &self.host,
                            self.port,
                            &detail,
                        );
                    }
                }
                Ok(true)
            }
            Ok(Ok(ssh_prompt::SshPromptAnswer::Reject)) => {
                // User explicitly rejected -> tell them, then fail-closed.
                let _ = ssh_prompt::notify_host_key(
                    ssh_prompt::SshHostKeyNoticeKind::Rejected,
                    &self.host,
                    self.port,
                    &format!("User rejected the host key for {}:{}.", self.host, self.port),
                );
                log::warn!("Host key for {}:{} was rejected by the user; aborting handshake", self.host, self.port);
                Ok(false)
            }
            Ok(Ok(ssh_prompt::SshPromptAnswer::Secret(_))) | Ok(Err(_)) | Err(_) => {
                log::warn!(
                    "Host key for {}:{} was not accepted (prompt timed out or was cancelled); aborting handshake",
                    self.host,
                    self.port
                );
                Ok(false)
            }
        }
    }
}

fn ssh_client_config() -> Config {
    let mut preferred = Preferred::default();
    let mut kex = preferred.kex.into_owned();
    // Appended after russh's safe defaults, so a modern server still negotiates
    // a modern algorithm. The SHA-1 group exchange and fixed-group entries are
    // the last resort for legacy OpenSSH (< 6.7) and appliance/bastion SSH
    // daemons whose entire offer is `diffie-hellman-group-exchange-sha1` plus
    // `diffie-hellman-group1-sha1`; without them the handshake aborts with
    // "No common Kex algorithm" before authentication is ever attempted.
    for algorithm in [
        kex::ECDH_SHA2_NISTP256,
        kex::ECDH_SHA2_NISTP384,
        kex::ECDH_SHA2_NISTP521,
        kex::DH_G14_SHA1,
        kex::DH_GEX_SHA1,
        kex::DH_G1_SHA1,
    ] {
        if !kex.contains(&algorithm) {
            kex.push(algorithm);
        }
    }

    let mut mac = preferred.mac.into_owned();
    // Keep SHA-1 MAC variants as last-resort fallbacks for legacy SSH proxies.
    for algorithm in [mac::HMAC_SHA1_ETM, mac::HMAC_SHA1] {
        if !mac.contains(&algorithm) {
            mac.push(algorithm);
        }
    }
    preferred.mac = Cow::Owned(mac);

    let mut ciphers = preferred.cipher.into_owned();
    // AES-CBC stays available as a last-resort fallback for old or appliance SSH
    // daemons whose entire offer is CBC (for example `aes256-cbc,aes128-cbc`),
    // which otherwise abort the handshake with "No common Cipher algorithm"
    // before authentication is ever attempted. The entries are appended behind
    // russh's safe defaults, so a capable server never negotiates down to CBC.
    // 3DES/blowfish/cast128/arcfour are deliberately left out: they are weaker
    // still, and a CBC-only daemon finds AES first in the same offer.
    for algorithm in [cipher::AES_256_CBC, cipher::AES_192_CBC, cipher::AES_128_CBC] {
        if !ciphers.contains(&algorithm) {
            ciphers.push(algorithm);
        }
    }
    preferred.cipher = Cow::Owned(ciphers);

    // Move the RFC 8308 / strict-kex extension marker names (ext-info-c,
    // ext-info-s, kex-strict-*-v00@openssh.com) to the tail of the offer.
    //
    // russh's default order places them mid-list, right after
    // `diffie-hellman-group14-sha256`. Some legacy SSH daemons (reproduced
    // against Apache MINA SSHD 0.9.5) abort the handshake with a bare TCP EOF
    // when the offer contains an unknown algorithm name immediately before
    // `ext-info-c`, so that default order kills the connection before auth.
    // OpenSSH itself advertises these markers at the end of its kex offer;
    // RFC 8308 does not require any particular position, so relocating them
    // keeps extension negotiation fully intact while avoiding the parser bug.
    let extension_markers = [
        russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
        russh::kex::EXTENSION_SUPPORT_AS_SERVER,
        russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
        russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
    ];
    kex.retain(|name| !extension_markers.contains(name));
    kex.extend(extension_markers);
    preferred.kex = Cow::Owned(kex);

    Config {
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(30)),
        preferred,
        gex: legacy_gex_params(),
        ..Default::default()
    }
}

/// Group-exchange bounds for the SHA-1 group exchange fallback above.
///
/// russh defaults to a 3072-bit minimum, which legacy daemons that only speak
/// `diffie-hellman-group-exchange-sha1` cannot satisfy: they reject the request
/// outright, so enabling the algorithm alone would still fail the handshake.
/// 2048 bits is russh's own floor for a client config and stays within current
/// guidance, while the preferred and maximum sizes keep russh's defaults so a
/// capable server is still driven to the largest group it supports.
fn legacy_gex_params() -> GexParams {
    GexParams::for_client_config(2048, 8192, 8192).unwrap_or_default()
}

fn tofu_prompt_deadline(network_deadline: Instant, prompt_started_at: Instant) -> Option<Instant> {
    (prompt_started_at < network_deadline).then_some(prompt_started_at + TOFU_PROMPT_TIMEOUT)
}

/// Returns `true` only when the server explicitly advertised `password` among
/// the authentication methods that may continue the dialog.
///
/// Per RFC 4252 §5.1, the "authentications that can continue" name-list is the
/// authoritative signal of what the server will accept next. A `partial_success`
/// flag alone is NOT a license to send a password: it merely reports that the
/// preceding step succeeded, and the next method may be something other than
/// `password` (e.g. `keyboard-interactive`). Honoring only the advertised list
/// prevents leaking the password to a server that never offered password auth
/// (the MITM credential-harvest case), while still covering publickey+password
/// MFA (where `password` IS present in the list).
fn server_offers_password(remaining_methods: &MethodSet) -> bool {
    remaining_methods.contains(&MethodKind::Password)
}

fn server_offers_keyboard_interactive(remaining_methods: &MethodSet) -> bool {
    remaining_methods.contains(&MethodKind::KeyboardInteractive)
}

fn auth_result_offers_keyboard_interactive(result: &AuthResult) -> bool {
    matches!(
        result,
        AuthResult::Failure { remaining_methods, .. }
            if server_offers_keyboard_interactive(remaining_methods)
    )
}

/// Describes a terminal (non-continuable) `AuthResult::Failure` for `action`
/// (e.g. "public key authentication"), choosing between `rejected_note` and a
/// generic "succeeded, but..." message based on `partial_success`.
///
/// `partial_success = true` means the factor just attempted was actually
/// *accepted*; the server is only asking for another one (publickey+password
/// or similar MFA chains). Reporting that as "rejected" — the failure mode
/// this replaced — is actively wrong and points the user at the wrong
/// credential to fix.
fn describe_terminal_auth_failure(
    action: &str,
    rejected_note: &str,
    remaining_methods: &MethodSet,
    partial_success: bool,
) -> String {
    if partial_success {
        format!(
            "SSH {action} succeeded, but the server still requires additional authentication \
             (remaining_methods={remaining_methods:?})"
        )
    } else {
        format!("SSH {action} failed: {rejected_note} (remaining_methods={remaining_methods:?})")
    }
}

fn keyboard_interactive_prompt_text(name: &str, instructions: &str, prompt: &str) -> String {
    [name.trim(), instructions.trim(), prompt.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn request_keyboard_interactive_answer(
    host: &str,
    port: u16,
    name: &str,
    instructions: &str,
    prompt: &russh::client::Prompt,
) -> Result<String, String> {
    let prompt_text = keyboard_interactive_prompt_text(name, instructions, &prompt.prompt);
    let request = ssh_prompt::secret_input_request(host, port, prompt_text, prompt.echo);
    let Some(responder_rx) = ssh_prompt::request_ssh_prompt(request) else {
        return Err(
            "SSH keyboard-interactive authentication requires user input, but no prompt UI is available".to_string()
        );
    };

    match tokio::time::timeout(KEYBOARD_INTERACTIVE_PROMPT_TIMEOUT, responder_rx).await {
        Ok(Ok(ssh_prompt::SshPromptAnswer::Secret(secret))) => Ok(secret),
        Ok(Ok(ssh_prompt::SshPromptAnswer::Reject)) => {
            Err("SSH keyboard-interactive authentication was cancelled".to_string())
        }
        Ok(Ok(ssh_prompt::SshPromptAnswer::Accept { .. })) => {
            Err("SSH keyboard-interactive authentication received an invalid response".to_string())
        }
        Ok(Err(_)) => Err("SSH keyboard-interactive authentication prompt was dismissed".to_string()),
        Err(_) => Err("SSH keyboard-interactive authentication prompt timed out".to_string()),
    }
}

async fn authenticate_keyboard_interactive(
    session: &mut Handle<SshClient>,
    ssh_user: &str,
    host: &str,
    port: u16,
    connect_timeout: Duration,
    connect_timeout_secs: u64,
) -> Result<(), String> {
    let mut response = tokio::time::timeout(
        connect_timeout,
        session.authenticate_keyboard_interactive_start(ssh_user, None::<String>),
    )
    .await
    .map_err(|_| format!("SSH keyboard-interactive auth timed out ({connect_timeout_secs}s)"))?
    .map_err(|e| format!("SSH keyboard-interactive auth failed: {e}"))?;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                return Err(format!(
                    "SSH keyboard-interactive authentication failed \
                     (remaining_methods={remaining_methods:?}, partial_success={partial_success})"
                ));
            }
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                let mut answers = Vec::with_capacity(prompts.len());
                for prompt in &prompts {
                    answers.push(request_keyboard_interactive_answer(host, port, &name, &instructions, prompt).await?);
                }

                response =
                    tokio::time::timeout(connect_timeout, session.authenticate_keyboard_interactive_respond(answers))
                        .await
                        .map_err(|_| format!("SSH keyboard-interactive auth timed out ({connect_timeout_secs}s)"))?
                        .map_err(|e| format!("SSH keyboard-interactive auth failed: {e}"))?;
            }
        }
    }
}

struct PendingSshAuthentication(Option<Handle<SshClient>>);

impl PendingSshAuthentication {
    fn finish(mut self) -> Handle<SshClient> {
        self.0.take().expect("pending SSH authentication owns its handle")
    }
}

impl Drop for PendingSshAuthentication {
    fn drop(&mut self) {
        let Some(session) = self.0.take() else { return };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::warn!("SSH authentication cleanup is unconfirmed: async runtime unavailable");
            return;
        };
        runtime.spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            let _ = tokio::time::timeout_at(
                deadline,
                session.disconnect(russh::Disconnect::ByApplication, "SSH authentication stopped", "en"),
            )
            .await;
            if !matches!(tokio::time::timeout_at(deadline, session).await, Ok(Ok(()))) {
                log::warn!("SSH authentication local task exit is unconfirmed");
            }
        });
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn connect_and_authenticate(
    connect_host: &str,
    connect_port: u16,
    host_key_host: &str,
    host_key_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    ssh_agent_key_fingerprint: &str,
    auth_method: &str,
    connect_timeout_secs: u64,
    known_hosts_path: &Path,
    proxy_command: &str,
) -> Result<Handle<SshClient>, String> {
    let config = Arc::new(ssh_client_config());
    let connect_timeout = Duration::from_secs(connect_timeout_secs);

    // Verify the logical SSH server identity against known_hosts before sending
    // credentials. For forwarded hops this identity intentionally differs from
    // the temporary TCP endpoint. Unknown keys require explicit UI acceptance;
    // changed keys, missing prompt gateways, timeouts, and rejection fail closed.
    let host_key_verifier = Arc::new(HostKeyVerifier::new(known_hosts_path.to_path_buf()));

    let (started_tx, mut started_rx) = mpsc::channel::<Instant>(1);
    let handler = SshClient {
        host_key_verifier: host_key_verifier.clone(),
        host: host_key_host.to_string(),
        port: host_key_port,
        prompt_started_tx: Some(started_tx),
    };
    // A ProxyCommand swaps the direct TCP connection for a helper process
    // (`nc`, `cloudflared`, ...) whose stdio carries the SSH handshake. Tokens
    // expand from the logical host/port so a forwarded jump hop still names
    // the host it is reaching rather than the previous hop's local endpoint.
    let proxy_stream = if proxy_command.trim().is_empty() {
        None
    } else {
        Some(crate::db::ssh_proxy_command::spawn_proxy_command_stream(
            proxy_command,
            host_key_host,
            host_key_port,
            ssh_user,
        )?)
    };
    let direct_host = connect_host.to_string();
    let connect_fut = async move {
        match proxy_stream {
            Some(stream) => client::connect_stream(config, stream, handler).await,
            None => client::connect(config, (direct_host.as_str(), connect_port), handler).await,
        }
    };
    tokio::pin!(connect_fut);

    // `connect_timeout` is meant to bound the *network* portion of the
    // handshake (TCP connect + KEX). But `check_server_key` can block on an
    // interactive TOFU prompt while the user reads/confirms the host-key
    // fingerprint, and that think-time must not be charged against the same
    // short budget -- otherwise accepting the dialog after it fires still
    // fails with a spurious "connection timed out". Once we're notified that
    // a prompt has actually started, we hand the remaining budget off to
    // TOFU_PROMPT_TIMEOUT (the real ceiling enforced inside
    // `prompt_for_host_key` itself); the network-only path is unaffected.
    let network_deadline = Instant::now() + connect_timeout;
    let sleep = tokio::time::sleep_until(network_deadline);
    tokio::pin!(sleep);
    let mut extended = false;

    let mut attempt = PendingSshAuthentication(Some(loop {
        tokio::select! {
            res = &mut connect_fut => break res.map_err(|e| format!("SSH connection failed: {e}"))?,
            _ = &mut sleep => return Err(format!("SSH connection timed out ({connect_timeout_secs}s)")),
            Some(prompt_started_at) = started_rx.recv(), if !extended => {
                extended = true;
                if let Some(prompt_deadline) = tofu_prompt_deadline(network_deadline, prompt_started_at) {
                    sleep.as_mut().reset(prompt_deadline);
                }
            }
        }
    }));
    let session = attempt.0.as_mut().expect("pending SSH authentication owns its handle");

    // Probe with "none" authentication first. Some SSH proxies and jump-hosts
    // accept connections without any credential, and this is also the standard
    // SSH probe used to discover the auth methods the server supports.
    let none_res = tokio::time::timeout(connect_timeout, session.authenticate_none(ssh_user))
        .await
        .map_err(|_| format!("SSH auth probe timed out ({connect_timeout_secs}s)"))?
        .map_err(|e| format!("SSH auth probe failed: {e}"))?;
    if none_res.success() {
        return Ok(attempt.finish());
    }

    // When auth_method is "none" and the probe was rejected, fail early
    // instead of falling back to other credential methods.
    if auth_method == "none" {
        return Err("SSH authentication failed: server rejected the connection without credentials".to_string());
    }

    // "key+password": try private key first, fall back to password on failure.
    // Both credential fields are expected to be filled in by the UI.
    if auth_method == "key+password" {
        // Attempt the private key first (when supplied), then decide whether a
        // password fallback is safe to attempt.
        let try_password = if ssh_key_path.is_empty() {
            // No key configured: only attempt password if the "none" probe
            // showed the server advertises it — otherwise we would leak the
            // password to any endpoint that rejected our (empty) key.
            match &none_res {
                AuthResult::Failure { remaining_methods, .. } => server_offers_password(remaining_methods),
                _ => false,
            }
        } else {
            validate_file_path(ssh_key_path, |_| false)?;

            let passphrase = if ssh_key_passphrase.is_empty() { None } else { Some(ssh_key_passphrase) };
            let key_pair =
                load_ssh_private_key(ssh_key_path, passphrase).map_err(|e| format!("Failed to load SSH key: {e}"))?;
            let auth_res = tokio::time::timeout(
                connect_timeout,
                session.authenticate_publickey(
                    ssh_user,
                    PrivateKeyWithHashAlg::new(
                        Arc::new(key_pair),
                        session.best_supported_rsa_hash().await.ok().flatten().flatten(),
                    ),
                ),
            )
            .await
            .map_err(|_| format!("SSH key auth timed out ({connect_timeout_secs}s)"))?
            .map_err(|e| format!("SSH key auth failed: {e}"))?;

            match auth_res {
                AuthResult::Success => return Ok(attempt.finish()),
                AuthResult::Failure { remaining_methods, partial_success } => {
                    if server_offers_keyboard_interactive(&remaining_methods) {
                        authenticate_keyboard_interactive(
                            session,
                            ssh_user,
                            host_key_host,
                            host_key_port,
                            connect_timeout,
                            connect_timeout_secs,
                        )
                        .await?;
                        return Ok(attempt.finish());
                    }
                    // Only fall back to password when the server still offers it.
                    // This prevents sending the password to a server that never
                    // advertised password auth — the MITM credential-harvest
                    // case — and preserves the protocol state needed for
                    // publickey+password MFA (where `password` IS in the list).
                    if server_offers_password(&remaining_methods) {
                        true
                    } else {
                        return Err(describe_terminal_auth_failure(
                            "public key authentication",
                            "the key was rejected and the server does not offer password authentication",
                            &remaining_methods,
                            partial_success,
                        ));
                    }
                }
            }
        };

        if try_password && !ssh_password.is_empty() {
            let auth_res = tokio::time::timeout(connect_timeout, session.authenticate_password(ssh_user, ssh_password))
                .await
                .map_err(|_| format!("SSH password auth timed out ({connect_timeout_secs}s)"))?
                .map_err(|e| format!("SSH password auth failed: {e}"))?;
            match auth_res {
                AuthResult::Success => return Ok(attempt.finish()),
                AuthResult::Failure { remaining_methods, partial_success } => {
                    if server_offers_keyboard_interactive(&remaining_methods) {
                        authenticate_keyboard_interactive(
                            session,
                            ssh_user,
                            host_key_host,
                            host_key_port,
                            connect_timeout,
                            connect_timeout_secs,
                        )
                        .await?;
                        return Ok(attempt.finish());
                    }
                    return Err(describe_terminal_auth_failure(
                        "password authentication",
                        "the server rejected the password",
                        &remaining_methods,
                        partial_success,
                    ));
                }
            }
        }

        return Err("SSH authentication failed: both key and password were rejected".to_string());
    }

    // "none" was rejected — fall back to the configured credential method.
    // When auth_method is set, only try the matching method.
    let try_key = auth_method.is_empty() && !ssh_key_path.is_empty() || auth_method == "key";
    let try_password = auth_method.is_empty() && !ssh_password.is_empty() || auth_method == "password";
    let try_agent = auth_method.is_empty() && use_ssh_agent || auth_method == "agent";

    if try_key {
        // Validate SSH key file path
        validate_file_path(ssh_key_path, |_| false)?;

        let passphrase = if ssh_key_passphrase.is_empty() { None } else { Some(ssh_key_passphrase) };
        let key_pair =
            load_ssh_private_key(ssh_key_path, passphrase).map_err(|e| format!("Failed to load SSH key: {e}"))?;
        let auth_res = tokio::time::timeout(
            connect_timeout,
            session.authenticate_publickey(
                ssh_user,
                PrivateKeyWithHashAlg::new(
                    Arc::new(key_pair),
                    session.best_supported_rsa_hash().await.ok().flatten().flatten(),
                ),
            ),
        )
        .await
        .map_err(|_| format!("SSH key auth timed out ({connect_timeout_secs}s)"))?
        .map_err(|e| format!("SSH key auth failed: {e}"))?;
        if auth_result_offers_keyboard_interactive(&auth_res) {
            authenticate_keyboard_interactive(
                session,
                ssh_user,
                host_key_host,
                host_key_port,
                connect_timeout,
                connect_timeout_secs,
            )
            .await?;
        } else if let AuthResult::Failure { remaining_methods, partial_success } = &auth_res {
            // Keep the structured detail russh returned, exactly like the
            // "key+password" branch above already does. Discarding it left the
            // user with a bare "authentication failed" that never said the key
            // itself was refused, nor what the server would still accept.
            return Err(describe_terminal_auth_failure(
                "public key authentication",
                "the server rejected the key",
                remaining_methods,
                *partial_success,
            ));
        }
    } else if try_password {
        let auth_res = tokio::time::timeout(connect_timeout, session.authenticate_password(ssh_user, ssh_password))
            .await
            .map_err(|_| format!("SSH password auth timed out ({connect_timeout_secs}s)"))?
            .map_err(|e| format!("SSH password auth failed: {e}"))?;
        if auth_result_offers_keyboard_interactive(&auth_res) {
            authenticate_keyboard_interactive(
                session,
                ssh_user,
                host_key_host,
                host_key_port,
                connect_timeout,
                connect_timeout_secs,
            )
            .await?;
        } else if let AuthResult::Failure { remaining_methods, partial_success } = &auth_res {
            return Err(describe_terminal_auth_failure(
                "password authentication",
                "the server rejected the password",
                remaining_methods,
                *partial_success,
            ));
        }
    } else if try_agent {
        match try_authenticate_with_agent(
            session,
            ssh_user,
            ssh_agent_sock_path,
            ssh_agent_key_fingerprint,
            &connect_timeout,
        )
        .await
        {
            Ok(AgentAuthenticationOutcome::Success) => {}
            Ok(AgentAuthenticationOutcome::KeyboardInteractiveRequired) => {
                authenticate_keyboard_interactive(
                    session,
                    ssh_user,
                    host_key_host,
                    host_key_port,
                    connect_timeout,
                    connect_timeout_secs,
                )
                .await?;
            }
            Err(agent_err) => return Err(agent_err),
        }
    } else if auth_result_offers_keyboard_interactive(&none_res) {
        authenticate_keyboard_interactive(
            session,
            ssh_user,
            host_key_host,
            host_key_port,
            connect_timeout,
            connect_timeout_secs,
        )
        .await?;
    } else {
        return Err(
            "SSH authentication failed: \"none\" was rejected and no password, key, or ssh-agent is configured"
                .to_string(),
        );
    }

    Ok(attempt.finish())
}

enum AgentAuthenticationOutcome {
    Success,
    KeyboardInteractiveRequired,
}

#[cfg(any(windows, test))]
const WINDOWS_OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowsSshAgentEndpoint {
    NamedPipe(String),
    Pageant,
}

#[cfg(any(windows, test))]
fn windows_ssh_agent_endpoints(configured_path: &str) -> Vec<WindowsSshAgentEndpoint> {
    let configured_path = configured_path.trim();
    if configured_path.is_empty() {
        vec![
            WindowsSshAgentEndpoint::NamedPipe(WINDOWS_OPENSSH_AGENT_PIPE.to_string()),
            WindowsSshAgentEndpoint::Pageant,
        ]
    } else {
        vec![WindowsSshAgentEndpoint::NamedPipe(configured_path.to_string())]
    }
}

#[cfg(windows)]
impl WindowsSshAgentEndpoint {
    fn label(&self) -> String {
        match self {
            Self::NamedPipe(path) => format!("Windows named pipe '{path}'"),
            Self::Pageant => "Pageant".to_string(),
        }
    }
}

#[cfg(unix)]
fn resolve_ssh_agent_socket_path(path: &str) -> String {
    expand_tilde(path)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentIdentityInfo {
    pub fingerprint: String,
    pub algorithm: String,
    pub comment: String,
}

impl AgentIdentityInfo {
    fn from_identity(identity: &AgentIdentity) -> Self {
        let public_key = identity.public_key();
        Self {
            fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
            algorithm: public_key.algorithm().as_str().to_string(),
            comment: identity.comment().to_string(),
        }
    }
}

fn agent_identity_fingerprint(identity: &AgentIdentity) -> String {
    identity.public_key().fingerprint(HashAlg::Sha256).to_string()
}

/// Normalizes the fingerprint forms users paste: `SHA256:abc...`,
/// `SHA256_abc...` (1Password's .pub filename form), any letter case,
/// surrounding whitespace.
fn normalize_ssh_fingerprint(value: &str) -> String {
    let trimmed = value.trim();
    let has_prefix = trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("SHA256:") || prefix.eq_ignore_ascii_case("SHA256_"));
    if !has_prefix {
        return trimmed.to_string();
    }
    format!("SHA256:{}", trimmed[7..].trim_end_matches('=').to_uppercase())
}

/// Keeps only the identity whose fingerprint the user selected. An empty
/// fingerprint keeps every identity, in the order the agent reported them.
fn select_agent_identities(
    identities: Vec<AgentIdentity>,
    ssh_agent_key_fingerprint: &str,
) -> Result<Vec<AgentIdentity>, String> {
    if ssh_agent_key_fingerprint.trim().is_empty() {
        return Ok(identities);
    }

    let wanted = normalize_ssh_fingerprint(ssh_agent_key_fingerprint);
    let available: Vec<(String, String)> = identities
        .iter()
        .map(|identity| (identity.comment().to_string(), agent_identity_fingerprint(identity)))
        .collect();
    let selected: Vec<AgentIdentity> = identities
        .into_iter()
        .filter(|identity| normalize_ssh_fingerprint(&agent_identity_fingerprint(identity)) == wanted)
        .collect();
    if !selected.is_empty() {
        return Ok(selected);
    }

    let available = available
        .iter()
        .take(10)
        .map(
            |(comment, fingerprint)| {
                if comment.trim().is_empty() {
                    fingerprint.clone()
                } else {
                    format!("{comment} ({fingerprint})")
                }
            },
        )
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "No ssh-agent identity matches the selected fingerprint {}. The agent reported: {available}. Select the key again in the tunnel profile's SSH settings.",
        ssh_agent_key_fingerprint.trim()
    ))
}

/// Lists the identities an agent exposes without asking it to sign anything,
/// so no confirmation dialog is triggered.
pub async fn list_agent_identities(ssh_agent_sock_path: &str) -> Result<Vec<AgentIdentityInfo>, String> {
    #[cfg(unix)]
    {
        let mut agent = connect_unix_agent(ssh_agent_sock_path).await?;
        list_identities_from_client(&mut agent).await
    }

    #[cfg(windows)]
    {
        let mut failures = Vec::new();
        for endpoint in windows_ssh_agent_endpoints(ssh_agent_sock_path) {
            let label = endpoint.label();
            let identities = match endpoint {
                WindowsSshAgentEndpoint::NamedPipe(path) => match AgentClient::connect_named_pipe(&path).await {
                    Ok(mut agent) => list_identities_from_client(&mut agent).await,
                    Err(error) => Err(format!("{label} is unavailable: {error}")),
                },
                WindowsSshAgentEndpoint::Pageant => match AgentClient::connect_pageant().await {
                    Ok(mut agent) => list_identities_from_client(&mut agent).await,
                    Err(error) => Err(format!("{label} is unavailable: {error}")),
                },
            };

            match identities {
                Ok(identities) => return Ok(identities),
                Err(error) => failures.push(error),
            }
        }

        Err(format!("No configured Windows ssh-agent transport could list identities: {}", failures.join("; ")))
    }
}

#[cfg(unix)]
async fn connect_unix_agent(ssh_agent_sock_path: &str) -> Result<AgentClient<tokio::net::UnixStream>, String> {
    if ssh_agent_sock_path.is_empty() {
        AgentClient::connect_env().await.map_err(|e| format!("ssh-agent is unavailable: {e}"))
    } else {
        let resolved_path = resolve_ssh_agent_socket_path(ssh_agent_sock_path);
        AgentClient::connect_uds(&resolved_path)
            .await
            .map_err(|e| format!("ssh-agent at '{resolved_path}' is unavailable: {e}"))
    }
}

async fn list_identities_from_client<S>(agent: &mut AgentClient<S>) -> Result<Vec<AgentIdentityInfo>, String>
where
    S: AgentStream + Send + Unpin,
{
    let identities = agent.request_identities().await.map_err(|e| format!("ssh-agent request failed: {e}"))?;
    Ok(identities.iter().map(AgentIdentityInfo::from_identity).collect())
}

/// What one public-key probe through an agent identity tells us about what to
/// do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentAttempt {
    Success,
    KeyboardInteractiveRequired,
    Continue,
    /// The server answered with an empty remaining-methods list: it will accept
    /// no further attempt on this connection (OpenSSH `MaxAuthTries`).
    ServerClosedAuthentication,
    /// The SSH session is gone; retrying the remaining identities cannot work.
    ConnectionLost,
}

fn classify_agent_attempt(result: &Result<AuthResult, russh::AgentAuthError>) -> AgentAttempt {
    match result {
        Ok(AuthResult::Success) => AgentAttempt::Success,
        Ok(AuthResult::Failure { remaining_methods, .. }) => {
            if server_offers_keyboard_interactive(remaining_methods) {
                AgentAttempt::KeyboardInteractiveRequired
            } else if remaining_methods.is_empty() {
                AgentAttempt::ServerClosedAuthentication
            } else {
                AgentAttempt::Continue
            }
        }
        Err(russh::AgentAuthError::Send(_)) => AgentAttempt::ConnectionLost,
        Err(russh::AgentAuthError::Key(_)) => AgentAttempt::Continue,
    }
}

fn describe_agent_attempt_failure(result: &Result<AuthResult, russh::AgentAuthError>) -> String {
    match result {
        Ok(AuthResult::Failure { remaining_methods, .. }) => {
            format!("the server rejected the key (remaining methods: {remaining_methods:?})")
        }
        Ok(_) => "the server rejected the key".to_string(),
        Err(error) => error.to_string(),
    }
}

fn agent_attempts_stopped_error(
    attempted: usize,
    total: usize,
    ssh_agent_key_fingerprint: &str,
    server_closed: bool,
) -> String {
    let cause = if server_closed { "the server closed authentication" } else { "the SSH session was lost" };
    if ssh_agent_key_fingerprint.trim().is_empty() {
        format!(
            "SSH agent authentication stopped: {cause} after attempting {attempted} of the {total} agent identities. Select the matching agent key so DBX offers only that identity; servers limit authentication attempts per connection."
        )
    } else {
        format!(
            "SSH agent authentication stopped: {cause} after attempting {attempted} of the {total} agent identities, before the selected key ({}) was accepted. Check the selected fingerprint.",
            ssh_agent_key_fingerprint.trim()
        )
    }
}

/// Try to authenticate using ssh-agent identities. A key may be only the first
/// successful factor, so preserve a server request to continue with
/// keyboard-interactive instead of discarding it and trying the next identity.
async fn try_authenticate_with_agent(
    session: &mut Handle<SshClient>,
    ssh_user: &str,
    ssh_agent_sock_path: &str,
    ssh_agent_key_fingerprint: &str,
    connect_timeout: &Duration,
) -> Result<AgentAuthenticationOutcome, String> {
    #[cfg(unix)]
    {
        let agent = connect_unix_agent(ssh_agent_sock_path)
            .await
            .map_err(|error| format!("No SSH password or key provided, and {error}"))?;
        authenticate_with_agent_client(session, ssh_user, agent, ssh_agent_key_fingerprint, connect_timeout).await
    }

    #[cfg(windows)]
    {
        let mut failures = Vec::new();
        for endpoint in windows_ssh_agent_endpoints(ssh_agent_sock_path) {
            let label = endpoint.label();
            // Every transport keeps its own concrete stream type. Erasing both into one
            // `dyn AgentStream` (russh's `AgentClient::dynamic`) makes rustc unable to
            // prove the spawned tunnel task is `Send`: the whole chain is rejected with
            // "implementation of `std::marker::Send` is not general enough" for the
            // `&str` user argument, which broke the Windows build.
            let outcome = match endpoint {
                WindowsSshAgentEndpoint::NamedPipe(path) => {
                    match tokio::time::timeout(*connect_timeout, AgentClient::connect_named_pipe(&path)).await {
                        Ok(Ok(agent)) => authenticate_with_agent_client(
                            session,
                            ssh_user,
                            agent,
                            ssh_agent_key_fingerprint,
                            connect_timeout,
                        )
                        .await
                        .map_err(|error| format!("{label}: {error}")),
                        Ok(Err(error)) => Err(format!("{label} is unavailable: {error}")),
                        Err(_) => Err(format!("{label} connection timed out")),
                    }
                }
                WindowsSshAgentEndpoint::Pageant => {
                    match tokio::time::timeout(*connect_timeout, AgentClient::connect_pageant()).await {
                        Ok(Ok(agent)) => authenticate_with_agent_client(
                            session,
                            ssh_user,
                            agent,
                            ssh_agent_key_fingerprint,
                            connect_timeout,
                        )
                        .await
                        .map_err(|error| format!("{label}: {error}")),
                        Ok(Err(error)) => Err(format!("{label} is unavailable: {error}")),
                        Err(_) => Err(format!("{label} connection timed out")),
                    }
                }
            };

            match outcome {
                Ok(outcome) => return Ok(outcome),
                Err(error) => failures.push(error),
            }
        }

        return Err(format!(
            "No SSH password or key provided, and all configured Windows ssh-agent transports failed: {}",
            failures.join("; ")
        ));
    }
}

async fn authenticate_with_agent_client<S>(
    session: &mut Handle<SshClient>,
    ssh_user: &str,
    mut agent: AgentClient<S>,
    ssh_agent_key_fingerprint: &str,
    connect_timeout: &Duration,
) -> Result<AgentAuthenticationOutcome, String>
where
    S: AgentStream + Send + Unpin + 'static,
{
    let identities = match agent.request_identities().await {
        Ok(ids) if ids.is_empty() => {
            return Err("No SSH password or key provided, and ssh-agent has no identities".to_string());
        }
        Ok(ids) => ids,
        Err(e) => {
            return Err(format!("No SSH password or key provided, and ssh-agent request failed: {e}"));
        }
    };
    let total_reported = identities.len();
    let identities = select_agent_identities(identities, ssh_agent_key_fingerprint)?;

    let hash_alg = session.best_supported_rsa_hash().await.ok().flatten().flatten();
    // An agent may hold the sign request until the user approves it, so the
    // network-oriented connect budget is only a lower bound here.
    let agent_auth_timeout = (*connect_timeout).max(Duration::from_secs(SSH_AGENT_AUTH_TIMEOUT_SECS));
    let total = identities.len();
    let mut attempted = 0usize;

    let auth_result = tokio::time::timeout(agent_auth_timeout, async {
        for identity in &identities {
            let comment = identity.comment();
            let fingerprint = agent_identity_fingerprint(identity);
            let result = match identity {
                AgentIdentity::PublicKey { key, .. } => {
                    session.authenticate_publickey_with(ssh_user, key.clone(), hash_alg, &mut agent).await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    session.authenticate_certificate_with(ssh_user, certificate.clone(), hash_alg, &mut agent).await
                }
            };
            attempted += 1;

            match classify_agent_attempt(&result) {
                AgentAttempt::Success => return Ok(AgentAuthenticationOutcome::Success),
                AgentAttempt::KeyboardInteractiveRequired => {
                    return Ok(AgentAuthenticationOutcome::KeyboardInteractiveRequired)
                }
                AgentAttempt::Continue => {
                    // Debug, not warn: offering every identity of an agent is
                    // the normal path, so a rejection here is expected traffic
                    // for a working setup and would spam the log on every
                    // connect.
                    log::debug!(
                        "SSH agent identity ({comment}, {fingerprint}) auth failed: {}",
                        describe_agent_attempt_failure(&result)
                    );
                }
                AgentAttempt::ServerClosedAuthentication => {
                    return Err(agent_attempts_stopped_error(
                        attempted,
                        total_reported,
                        ssh_agent_key_fingerprint,
                        true,
                    ))
                }
                AgentAttempt::ConnectionLost => {
                    return Err(agent_attempts_stopped_error(
                        attempted,
                        total_reported,
                        ssh_agent_key_fingerprint,
                        false,
                    ))
                }
            }
        }
        Err(format!(
            "No SSH password or key provided, and no ssh-agent identity was accepted ({attempted} of {total} identities tried)"
        ))
    })
    .await;

    match auth_result {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!(
            "SSH agent authentication timed out after {}s; approve the agent prompt and retry",
            agent_auth_timeout.as_secs()
        )),
    }
}

fn load_ssh_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let expanded = expand_tilde(path);
    let secret = fs::read_to_string(&expanded).map_err(|e| e.to_string())?;
    match decode_secret_key(&secret, passphrase) {
        Ok(key) => Ok(key),
        Err(err) if is_ssh_key_character_encoding_error(&err.to_string()) => {
            let sanitized = sanitize_unencrypted_openssh_comment(&secret)?;
            decode_secret_key(&sanitized, passphrase).map_err(|retry_err| retry_err.to_string())
        }
        Err(err) => Err(err.to_string()),
    }
}

fn is_ssh_key_character_encoding_error(error: &str) -> bool {
    error.contains("SshKey: character encoding invalid")
}

fn sanitize_unencrypted_openssh_comment(secret: &str) -> Result<String, String> {
    const BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const END: &str = "-----END OPENSSH PRIVATE KEY-----";

    if !secret.lines().any(|line| line == BEGIN) {
        return Err("SSH key comment encoding is invalid and the key is not an OpenSSH private key".to_string());
    }

    let body = secret.lines().filter(|line| !line.starts_with("-----")).collect::<String>();
    let mut bytes =
        BASE64_STANDARD.decode(body.as_bytes()).map_err(|e| format!("OpenSSH key base64 decode failed: {e}"))?;

    sanitize_unencrypted_openssh_comment_bytes(&mut bytes)?;

    Ok(format!("{BEGIN}\n{}\n{END}\n", BASE64_STANDARD.encode(bytes)))
}

fn sanitize_unencrypted_openssh_comment_bytes(bytes: &mut Vec<u8>) -> Result<(), String> {
    const AUTH_MAGIC: &[u8] = b"openssh-key-v1\0";

    if !bytes.starts_with(AUTH_MAGIC) {
        return Err("OpenSSH key header is invalid".to_string());
    }

    let mut pos = AUTH_MAGIC.len();
    let ciphername = read_ssh_string(bytes, &mut pos)?;
    if ciphername != b"none" {
        return Err("SSH key comment encoding is invalid and encrypted OpenSSH keys cannot be sanitized".to_string());
    }

    let _kdfname = read_ssh_string(bytes, &mut pos)?;
    let _kdfoptions = read_ssh_string(bytes, &mut pos)?;
    let key_count = read_u32(bytes, &mut pos)?;
    if key_count != 1 {
        return Err("OpenSSH keys with multiple private keys are unsupported".to_string());
    }

    let _public_key = read_ssh_string(bytes, &mut pos)?;
    let private_blob_len_pos = pos;
    let private_blob = read_ssh_string(bytes, &mut pos)?;
    let patched_private_blob = sanitize_private_blob_comment(private_blob)?;
    let patched_private_blob_len = (patched_private_blob.len() as u32).to_be_bytes();

    bytes.splice(private_blob_len_pos..pos, patched_private_blob_len.into_iter().chain(patched_private_blob));

    Ok(())
}

fn sanitize_private_blob_comment(blob: &[u8]) -> Result<Vec<u8>, String> {
    let unpadded_end = blob
        .len()
        .checked_sub(openssh_padding_len(blob)?)
        .ok_or_else(|| "OpenSSH private key padding is invalid".to_string())?;
    let comment_len_pos = find_trailing_ssh_string_len_pos(&blob[..unpadded_end])
        .ok_or_else(|| "OpenSSH private key comment field was not found".to_string())?;

    let mut patched = Vec::with_capacity(blob.len());
    patched.extend_from_slice(&blob[..comment_len_pos]);
    patched.extend_from_slice(&0u32.to_be_bytes());

    let padding_len = padding_len_for_block(patched.len(), 8);
    for value in 1..=padding_len {
        patched.push(value as u8);
    }

    Ok(patched)
}

fn openssh_padding_len(bytes: &[u8]) -> Result<usize, String> {
    for len in (1..=16).rev() {
        if bytes.len() >= len
            && bytes[bytes.len() - len..].iter().enumerate().all(|(index, byte)| *byte == (index + 1) as u8)
        {
            return Ok(len);
        }
    }

    Err("OpenSSH private key padding is invalid".to_string())
}

fn find_trailing_ssh_string_len_pos(bytes: &[u8]) -> Option<usize> {
    (8..bytes.len().saturating_sub(3)).rev().find(|pos| {
        let Some(len_bytes) = bytes.get(*pos..*pos + 4) else {
            return false;
        };
        let len = u32::from_be_bytes(len_bytes.try_into().expect("slice length checked")) as usize;
        pos.checked_add(4).and_then(|value| value.checked_add(len)) == Some(bytes.len())
    })
}

fn padding_len_for_block(len: usize, block_size: usize) -> usize {
    let remainder = len % block_size;
    if remainder == 0 {
        block_size
    } else {
        block_size - remainder
    }
}

fn read_ssh_string<'a>(bytes: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let len = read_u32(bytes, pos)? as usize;
    let end = pos.checked_add(len).ok_or_else(|| "OpenSSH key field length is invalid".to_string())?;
    if end > bytes.len() {
        return Err("OpenSSH key field is truncated".to_string());
    }

    let value = &bytes[*pos..end];
    *pos = end;
    Ok(value)
}

fn read_u32(bytes: &[u8], pos: &mut usize) -> Result<u32, String> {
    let end = pos.checked_add(4).ok_or_else(|| "OpenSSH key field length is invalid".to_string())?;
    let value = bytes.get(*pos..end).ok_or_else(|| "OpenSSH key field is truncated".to_string())?;
    *pos = end;

    Ok(u32::from_be_bytes(value.try_into().map_err(|_| "OpenSSH key field length is invalid".to_string())?))
}

/// Build a POSIX-shell-safe netcat command for SSH servers (notably
/// JumpServer/Koko) that reject `direct-tcpip` but allow an exec channel on the
/// selected asset. The target is single-quoted because it originates in the
/// connection configuration and is ultimately passed through a remote shell.
fn netcat_proxy_command(remote_host: &str, remote_port: u16) -> Result<String, String> {
    if remote_host.is_empty() || remote_host.contains('\0') || remote_host.chars().any(char::is_control) {
        return Err("SSH tunnel target host is invalid".to_string());
    }
    let quoted_host = remote_host.replace('\'', "'\\''");
    Ok(format!("exec nc '{quoted_host}' {remote_port}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TunnelTarget {
    Fixed { host: String, port: u16 },
    Socks5,
}

impl TunnelTarget {
    fn description(&self) -> String {
        match self {
            Self::Fixed { host, port } => format!("{host}:{port}"),
            Self::Socks5 => "dynamic SOCKS5 targets".to_string(),
        }
    }
}

async fn read_socks5_target(stream: &mut tokio::net::TcpStream) -> Result<(String, u16), String> {
    let mut greeting = [0_u8; 2];
    stream.read_exact(&mut greeting).await.map_err(|e| format!("SOCKS5 greeting failed: {e}"))?;
    if greeting[0] != 0x05 || greeting[1] == 0 {
        return Err("Invalid SOCKS5 greeting".to_string());
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await.map_err(|e| format!("SOCKS5 methods failed: {e}"))?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err("SOCKS5 client does not support no-auth mode".to_string());
    }
    stream.write_all(&[0x05, 0x00]).await.map_err(|e| format!("SOCKS5 method reply failed: {e}"))?;

    let mut request = [0_u8; 4];
    stream.read_exact(&mut request).await.map_err(|e| format!("SOCKS5 request failed: {e}"))?;
    if request[0] != 0x05 {
        return Err("Invalid SOCKS5 request version".to_string());
    }
    if request[1] != 0x01 {
        let _ = write_socks5_reply(stream, 0x07).await;
        return Err("SOCKS5 command is not CONNECT".to_string());
    }

    let host = match request[3] {
        0x01 => {
            let mut addr = [0_u8; 4];
            stream.read_exact(&mut addr).await.map_err(|e| format!("SOCKS5 IPv4 target failed: {e}"))?;
            std::net::Ipv4Addr::from(addr).to_string()
        }
        0x03 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len).await.map_err(|e| format!("SOCKS5 domain length failed: {e}"))?;
            if len[0] == 0 {
                let _ = write_socks5_reply(stream, 0x08).await;
                return Err("SOCKS5 target host is empty".to_string());
            }
            let mut host = vec![0_u8; len[0] as usize];
            stream.read_exact(&mut host).await.map_err(|e| format!("SOCKS5 domain target failed: {e}"))?;
            String::from_utf8(host).map_err(|_| "SOCKS5 target host is not UTF-8".to_string())?
        }
        0x04 => {
            let mut addr = [0_u8; 16];
            stream.read_exact(&mut addr).await.map_err(|e| format!("SOCKS5 IPv6 target failed: {e}"))?;
            std::net::Ipv6Addr::from(addr).to_string()
        }
        _ => {
            let _ = write_socks5_reply(stream, 0x08).await;
            return Err("Unsupported SOCKS5 address type".to_string());
        }
    };
    let mut port = [0_u8; 2];
    stream.read_exact(&mut port).await.map_err(|e| format!("SOCKS5 target port failed: {e}"))?;
    Ok((host, u16::from_be_bytes(port)))
}

async fn write_socks5_reply(stream: &mut tokio::net::TcpStream, status: u8) -> Result<(), String> {
    stream
        .write_all(&[0x05, status, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        .await
        .map_err(|e| format!("SOCKS5 reply failed: {e}"))
}

/// Accept connections on the local listener and forward them through the SSH session.
/// Returns when the SSH session dies (listener error or session.is_closed()).
async fn forward_loop(
    session: &Handle<SshClient>,
    listener: &TcpListener,
    target: &TunnelTarget,
    allow_exec_channel_proxy: bool,
) {
    let mut idle_check = tokio::time::interval(IDLE_SESSION_CHECK_INTERVAL);
    idle_check.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        let accepted = tokio::select! {
            result = listener.accept() => result,
            _ = idle_check.tick() => {
                if session.is_closed() {
                    log::warn!("SSH session closed while tunnel was idle");
                    break;
                }
                match tokio::time::timeout(IDLE_SESSION_PING_TIMEOUT, session.send_ping()).await {
                    Ok(Ok(())) => continue,
                    Ok(Err(e)) => {
                        log::warn!("SSH idle ping failed: {e}");
                        break;
                    }
                    Err(_) => {
                        log::warn!("SSH idle ping timed out");
                        break;
                    }
                }
            }
        };

        let (mut stream, peer_addr) = match accepted {
            Ok(v) => v,
            Err(e) => {
                log::error!("SSH tunnel listener error: {e}");
                break;
            }
        };

        // Check session health before opening a new channel
        if session.is_closed() {
            log::warn!("SSH session closed, exiting forward loop");
            break;
        }

        let (remote_host, remote_port) = match target {
            TunnelTarget::Fixed { host, port } => (host.clone(), *port),
            TunnelTarget::Socks5 => match read_socks5_target(&mut stream).await {
                Ok(target) => target,
                Err(e) => {
                    log::debug!("SSH SOCKS5 request rejected: {e}");
                    continue;
                }
            },
        };

        let channel = match session
            .channel_open_direct_tcpip(
                &remote_host,
                remote_port.into(),
                peer_addr.ip().to_string(),
                peer_addr.port().into(),
            )
            .await
        {
            Ok(c) => c,
            Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited))
                if allow_exec_channel_proxy =>
            {
                // JumpServer/Koko deliberately disables SSH direct-tcpip even
                // for a directly selected asset. An exec channel is still
                // proxied to that asset, so use netcat there as a byte stream.
                let command = match netcat_proxy_command(&remote_host, remote_port) {
                    Ok(command) => command,
                    Err(e) => {
                        log::error!("SSH netcat fallback rejected the target: {e}");
                        if matches!(target, TunnelTarget::Socks5) {
                            let _ = write_socks5_reply(&mut stream, 0x01).await;
                            continue;
                        }
                        break;
                    }
                };
                let channel = match session.channel_open_session().await {
                    Ok(channel) => channel,
                    Err(e) => {
                        log::error!("SSH netcat fallback could not open a session channel: {e}");
                        if matches!(target, TunnelTarget::Socks5) {
                            let _ = write_socks5_reply(&mut stream, 0x01).await;
                        }
                        continue;
                    }
                };
                if let Err(e) = channel.exec(true, command).await {
                    log::error!("SSH netcat fallback could not start nc: {e}");
                    if matches!(target, TunnelTarget::Socks5) {
                        let _ = write_socks5_reply(&mut stream, 0x01).await;
                        continue;
                    }
                    break;
                }
                log::info!("SSH direct-tcpip is disabled; forwarding through a remote nc session");
                channel
            }
            Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited)) => {
                log::warn!("SSH direct-tcpip was administratively prohibited; exec-channel proxy fallback is disabled");
                if matches!(target, TunnelTarget::Socks5) {
                    let _ = write_socks5_reply(&mut stream, 0x02).await;
                    continue;
                }
                break;
            }
            Err(e) => {
                log::error!("SSH direct-tcpip failed: {e}");
                if matches!(target, TunnelTarget::Socks5) {
                    let _ = write_socks5_reply(&mut stream, 0x01).await;
                    continue;
                }
                break;
            }
        };

        if matches!(target, TunnelTarget::Socks5) {
            if let Err(e) = write_socks5_reply(&mut stream, 0x00).await {
                log::debug!("SSH SOCKS5 success reply failed: {e}");
                continue;
            }
        }

        tokio::spawn(async move {
            let mut channel_stream = channel.into_stream();
            if let Err(e) = tokio::io::copy_bidirectional(&mut stream, &mut channel_stream).await {
                log::debug!("SSH tunnel stream ended with an I/O error: {e}");
            }
        });
    }
}

/// Main tunnel task: runs the forward loop and automatically reconnects
/// the SSH session when it drops. The local TcpListener survives across
/// reconnections so the tunnel appears continuously available to clients.
/// Uses exponential backoff for reconnect attempts and gives up after
/// MAX_RECONNECT_ATTEMPTS to avoid log storms from permanent failures.
#[allow(clippy::too_many_arguments)]
async fn tunnel_reconnect_loop(
    mut session: Handle<SshClient>,
    connect_host: String,
    connect_port: u16,
    host_key_host: String,
    host_key_port: u16,
    ssh_user: String,
    ssh_password: String,
    ssh_key_path: String,
    ssh_key_passphrase: String,
    use_ssh_agent: bool,
    ssh_agent_sock_path: String,
    ssh_agent_key_fingerprint: String,
    auth_method: String,
    connect_timeout_secs: u64,
    known_hosts_path: PathBuf,
    listener: TcpListener,
    target: TunnelTarget,
    allow_exec_channel_proxy: bool,
    status: Arc<TunnelStatus>,
    proxy_command: String,
) {
    loop {
        // Reaching the top of the loop means a live session: either the initial
        // handshake or a successful reconnect. Clear any recorded failure.
        status.mark_connected();
        log::info!("SSH tunnel active: {}:{} -> {}", connect_host, connect_port, target.description());

        forward_loop(&session, &listener, &target, allow_exec_channel_proxy).await;

        status.mark_disconnected();
        log::warn!("SSH tunnel connection lost ({}:{}), reconnecting...", connect_host, connect_port);

        // Reconnect with exponential backoff
        let mut delay = INITIAL_RECONNECT_DELAY;
        let mut attempts: u32 = 0;

        loop {
            if attempts >= MAX_RECONNECT_ATTEMPTS {
                log::error!(
                    "SSH tunnel ({connect_host}:{connect_port}): max reconnect attempts ({MAX_RECONNECT_ATTEMPTS}) exhausted, giving up"
                );
                return;
            }

            tokio::time::sleep(delay).await;

            match connect_and_authenticate(
                &connect_host,
                connect_port,
                &host_key_host,
                host_key_port,
                &ssh_user,
                &ssh_password,
                &ssh_key_path,
                &ssh_key_passphrase,
                use_ssh_agent,
                &ssh_agent_sock_path,
                &ssh_agent_key_fingerprint,
                &auth_method,
                connect_timeout_secs,
                &known_hosts_path,
                &proxy_command,
            )
            .await
            {
                Ok(new_session) => {
                    session = new_session;
                    status.mark_connected();
                    log::info!(
                        "SSH tunnel reconnected to {}:{} (attempt {})",
                        connect_host,
                        connect_port,
                        attempts + 1
                    );
                    break;
                }
                Err(e) => {
                    attempts += 1;
                    log::error!(
                        "SSH reconnect failed ({}:{}, attempt {attempts}/{MAX_RECONNECT_ATTEMPTS}): {e}",
                        connect_host,
                        connect_port,
                    );
                    // Publish the reason as well as logging it. Without this the
                    // tunnel keeps a local listener open with no SSH session
                    // behind it, and the next database connection fails with an
                    // unrelated generic I/O error instead of this cause.
                    status.record_failure(format!(
                        "SSH tunnel to {connect_host}:{connect_port} lost its session and could not reconnect: {e}"
                    ));
                    // Exponential backoff: double the delay, cap at MAX_RECONNECT_DELAY
                    delay = std::cmp::min(delay * 2, MAX_RECONNECT_DELAY);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TunnelKind {
    Fixed,
    Socks5,
}

/// Shared health state of one tunnel's background task.
///
/// [`tunnel_reconnect_loop`] runs detached from whoever started the tunnel, so
/// a failure there — typically an SSH authentication rejection — used to be
/// visible only through `log::error!`. Recording it here lets [`TunnelManager`]
/// answer the next `start_*` call with the real reason instead of handing back
/// a local port whose SSH session is dead, which reached the user as an
/// unrelated generic driver error such as "connection closed".
///
/// The three states used to be a separate `AtomicBool` (`connected`) and
/// `Mutex<Option<String>>` (`last_error`), published as two independent
/// writes. A reader could observe the gap between them — `connected = false`
/// with `last_error` still `None` — and conclude the tunnel was healthy while
/// it was actually mid-failure, handing back a dead local port. Folding both
/// into one enum behind one lock makes that state unrepresentable: every
/// transition is a single atomic write.
#[derive(Clone)]
enum TunnelHealth {
    Connected,
    /// Session just dropped; a short backoff window is normal and callers
    /// should keep using the port rather than be given a spurious error.
    Reconnecting,
    Failed(String),
}

struct TunnelStatus {
    health: std::sync::Mutex<TunnelHealth>,
}

impl TunnelStatus {
    /// A tunnel is only registered after a successful handshake, so it starts
    /// out connected.
    fn new_connected() -> Self {
        Self { health: std::sync::Mutex::new(TunnelHealth::Connected) }
    }

    fn mark_connected(&self) {
        if let Ok(mut health) = self.health.lock() {
            *health = TunnelHealth::Connected;
        }
    }

    fn mark_disconnected(&self) {
        if let Ok(mut health) = self.health.lock() {
            *health = TunnelHealth::Reconnecting;
        }
    }

    fn record_failure(&self, error: String) {
        if let Ok(mut health) = self.health.lock() {
            *health = TunnelHealth::Failed(error);
        }
    }

    /// The reason this tunnel is currently unusable, when that reason is known.
    ///
    /// Returns `None` while the tunnel is up, and deliberately also during the
    /// first backoff window after a session drop: a short blip normally
    /// reconnects on its own, and callers should keep using the port rather
    /// than be given a spurious error. Only once a reconnect attempt has
    /// actually been refused do we report it.
    fn failure(&self) -> Option<String> {
        match self.health.lock().ok()?.clone() {
            TunnelHealth::Failed(error) => Some(error),
            TunnelHealth::Connected | TunnelHealth::Reconnecting => None,
        }
    }
}

struct TunnelEntry {
    handles: Vec<JoinHandle<()>>,
    statuses: Vec<Arc<TunnelStatus>>,
    local_port: u16,
    kind: TunnelKind,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedTunnel {
    connect_host: String,
    connect_port: u16,
    host_key_host: String,
    host_key_port: u16,
    remote_host: String,
    remote_port: u16,
}

pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, TunnelEntry>>,
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// dbx-managed known_hosts path (`<data_dir>/known_hosts`) threaded into
    /// every SSH connection for host-key verification.
    known_hosts_path: PathBuf,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new(PathBuf::new())
    }
}

impl TunnelManager {
    pub fn new(data_dir: PathBuf) -> Self {
        let known_hosts_path = data_dir.join("known_hosts");
        Self { tunnels: Mutex::new(HashMap::new()), start_locks: Mutex::new(HashMap::new()), known_hosts_path }
    }

    pub fn known_hosts_path(&self) -> &Path {
        &self.known_hosts_path
    }

    async fn start_lock(&self, connection_id: &str) -> Arc<Mutex<()>> {
        self.start_locks
            .lock()
            .await
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_tunnel(
        &self,
        connection_id: &str,
        connect_host: &str,
        connect_port: u16,
        host_key_host: &str,
        host_key_port: u16,
        ssh_user: &str,
        ssh_password: &str,
        ssh_key_path: &str,
        ssh_key_passphrase: &str,
        use_ssh_agent: bool,
        ssh_agent_sock_path: &str,
        ssh_agent_key_fingerprint: &str,
        auth_method: &str,
        connect_timeout_secs: u64,
        remote_host: &str,
        remote_port: u16,
        expose_to_lan: bool,
        allow_exec_channel_proxy: bool,
        proxy_command: &str,
    ) -> Result<u16, String> {
        self.start_tunnel_on_local_port(
            connection_id,
            connect_host,
            connect_port,
            host_key_host,
            host_key_port,
            ssh_user,
            ssh_password,
            ssh_key_path,
            ssh_key_passphrase,
            use_ssh_agent,
            ssh_agent_sock_path,
            ssh_agent_key_fingerprint,
            auth_method,
            connect_timeout_secs,
            remote_host,
            remote_port,
            expose_to_lan,
            allow_exec_channel_proxy,
            None,
            proxy_command,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_tunnel_on_local_port(
        &self,
        connection_id: &str,
        connect_host: &str,
        connect_port: u16,
        host_key_host: &str,
        host_key_port: u16,
        ssh_user: &str,
        ssh_password: &str,
        ssh_key_path: &str,
        ssh_key_passphrase: &str,
        use_ssh_agent: bool,
        ssh_agent_sock_path: &str,
        ssh_agent_key_fingerprint: &str,
        auth_method: &str,
        connect_timeout_secs: u64,
        remote_host: &str,
        remote_port: u16,
        expose_to_lan: bool,
        allow_exec_channel_proxy: bool,
        requested_local_port: Option<u16>,
        proxy_command: &str,
    ) -> Result<u16, String> {
        let healthy = Self::healthy_port(&*self.tunnels.lock().await, connection_id, TunnelKind::Fixed);
        if let Some(port) = healthy.filter(|port| requested_local_port.is_none_or(|requested| requested == *port)) {
            return Ok(port);
        }

        let start_lock = self.start_lock(connection_id).await;
        let _start_guard = start_lock.lock().await;

        // A concurrent caller may have completed while this task waited.
        if let Some(port) = self.active_port(connection_id, TunnelKind::Fixed, requested_local_port).await? {
            return Ok(port);
        }
        let (handle, local_port, status) = spawn_tunnel(
            connect_host,
            connect_port,
            host_key_host,
            host_key_port,
            ssh_user,
            ssh_password,
            ssh_key_path,
            ssh_key_passphrase,
            use_ssh_agent,
            ssh_agent_sock_path,
            ssh_agent_key_fingerprint,
            auth_method,
            connect_timeout_secs,
            &self.known_hosts_path,
            remote_host,
            remote_port,
            expose_to_lan,
            allow_exec_channel_proxy,
            requested_local_port,
            proxy_command,
        )
        .await?;

        let handle = AbortOnDropHandle::new(handle);
        let mut tunnels = self.tunnels.lock().await;
        tunnels.insert(
            connection_id.to_string(),
            TunnelEntry { handles: vec![handle.detach()], statuses: vec![status], local_port, kind: TunnelKind::Fixed },
        );
        Ok(local_port)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_socks5_proxy(
        &self,
        connection_id: &str,
        connect_host: &str,
        connect_port: u16,
        host_key_host: &str,
        host_key_port: u16,
        ssh_user: &str,
        ssh_password: &str,
        ssh_key_path: &str,
        ssh_key_passphrase: &str,
        use_ssh_agent: bool,
        ssh_agent_sock_path: &str,
        ssh_agent_key_fingerprint: &str,
        auth_method: &str,
        connect_timeout_secs: u64,
        allow_exec_channel_proxy: bool,
        proxy_command: &str,
    ) -> Result<u16, String> {
        let healthy = Self::healthy_port(&*self.tunnels.lock().await, connection_id, TunnelKind::Socks5);
        if let Some(port) = healthy {
            return Ok(port);
        }

        let start_lock = self.start_lock(connection_id).await;
        let _start_guard = start_lock.lock().await;
        if let Some(port) = self.active_port(connection_id, TunnelKind::Socks5, None).await? {
            return Ok(port);
        }

        let (handle, local_port, status) = spawn_socks5_proxy(
            connect_host,
            connect_port,
            host_key_host,
            host_key_port,
            ssh_user,
            ssh_password,
            ssh_key_path,
            ssh_key_passphrase,
            use_ssh_agent,
            ssh_agent_sock_path,
            ssh_agent_key_fingerprint,
            auth_method,
            connect_timeout_secs,
            &self.known_hosts_path,
            allow_exec_channel_proxy,
            proxy_command,
        )
        .await?;

        let handle = AbortOnDropHandle::new(handle);
        let mut tunnels = self.tunnels.lock().await;
        tunnels.insert(
            connection_id.to_string(),
            TunnelEntry {
                handles: vec![handle.detach()],
                statuses: vec![status],
                local_port,
                kind: TunnelKind::Socks5,
            },
        );
        Ok(local_port)
    }

    /// Returns the local port for a cached tunnel entry.
    ///
    /// * `Ok(None)` — no usable entry: it is absent, of the wrong kind, or
    ///   stale because every background handle has exited. The caller starts a
    ///   fresh tunnel, and any handshake error surfaces from that attempt.
    /// * `Err(reason)` — the background task is still running but its SSH
    ///   session is known to be down and we know why (a reconnect was refused).
    ///   Reporting the recorded reason is what stops the caller from handing a
    ///   port with no live SSH session behind it to a database driver, which is
    ///   what turned an SSH auth rejection into a generic "connection closed".
    ///   The dead entry is dropped at the same time, so a later attempt (for
    ///   example after the user fixes the key) performs a fresh handshake
    ///   instead of replaying the recorded failure until the retry budget runs
    ///   out.
    /// * `Ok(Some(port))` — the tunnel is healthy.
    ///
    /// The handles of an evicted entry are pushed to `evicted` instead of only
    /// being aborted: the caller must `abort_and_join` them once it has released
    /// the tunnels lock, because a task keeps its listener bound until it is
    /// actually dropped.
    fn get_active_port(
        tunnels: &mut HashMap<String, TunnelEntry>,
        connection_id: &str,
        expected_kind: TunnelKind,
        evicted: &mut Vec<JoinHandle<()>>,
    ) -> Result<Option<u16>, String> {
        let Some(entry) = tunnels.get(connection_id) else {
            return Ok(None);
        };
        if entry.kind != expected_kind || entry.handles.iter().all(|h| h.is_finished()) {
            evicted.extend(tunnels.remove(connection_id).into_iter().flat_map(|entry| entry.handles));
            return Ok(None);
        }
        let local_port = entry.local_port;
        let failure = entry.statuses.iter().find_map(|status| status.failure());
        if let Some(failure) = failure {
            evicted.extend(tunnels.remove(connection_id).into_iter().flat_map(|entry| entry.handles));
            return Err(failure);
        }
        Ok(Some(local_port))
    }

    /// Port of a cached tunnel that is usable right now. Unlike
    /// [`Self::get_active_port`] it never evicts, so the lock-free fast path
    /// leaves a stale or failed entry to the caller that holds the start lock.
    /// Evicting there would let a concurrent starter rebind the same fixed port
    /// while the evicted task still owns its listener.
    fn healthy_port(
        tunnels: &HashMap<String, TunnelEntry>,
        connection_id: &str,
        expected_kind: TunnelKind,
    ) -> Option<u16> {
        let entry = tunnels.get(connection_id)?;
        let usable = entry.kind == expected_kind
            && !entry.handles.iter().all(|h| h.is_finished())
            && entry.statuses.iter().all(|status| status.failure().is_none());
        usable.then_some(entry.local_port)
    }

    /// [`Self::get_active_port`] for a caller that holds the start lock: evicted
    /// tunnels are joined before returning, so a following bind of the same
    /// local port cannot hit `EADDRINUSE`. A healthy tunnel on another port than
    /// `required_port` is evicted too.
    async fn active_port(
        &self,
        connection_id: &str,
        expected_kind: TunnelKind,
        required_port: Option<u16>,
    ) -> Result<Option<u16>, String> {
        let mut evicted = Vec::new();
        let active = {
            let mut tunnels = self.tunnels.lock().await;
            match Self::get_active_port(&mut tunnels, connection_id, expected_kind, &mut evicted) {
                Ok(Some(port)) if required_port.is_some_and(|required| required != port) => {
                    evicted.extend(tunnels.remove(connection_id).into_iter().flat_map(|entry| entry.handles));
                    Ok(None)
                }
                active => active,
            }
        };
        abort_and_join(evicted).await;
        active
    }

    pub async fn start_chain(
        &self,
        connection_id: &str,
        hops: &[SshTunnelConfig],
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, String> {
        if hops.is_empty() {
            return Err("No SSH tunnel hops configured".to_string());
        }
        let healthy = Self::healthy_port(&*self.tunnels.lock().await, connection_id, TunnelKind::Fixed);
        if let Some(port) = healthy {
            return Ok(port);
        }

        let start_lock = self.start_lock(connection_id).await;
        let _start_guard = start_lock.lock().await;
        if let Some(port) = self.active_port(connection_id, TunnelKind::Fixed, None).await? {
            return Ok(port);
        }
        let mut handles = Vec::new();
        let mut statuses = Vec::new();
        let mut next_connect_endpoint: Option<(String, u16)> = None;
        let mut final_local_port = 0;

        for (index, hop) in hops.iter().enumerate() {
            let is_last = index + 1 == hops.len();
            let (connect_host, connect_port) =
                next_connect_endpoint.clone().unwrap_or_else(|| (hop.host.clone(), hop.port));
            let (target_host, target_port) = if is_last {
                (remote_host.to_string(), remote_port)
            } else {
                (hops[index + 1].host.clone(), hops[index + 1].port)
            };

            let (handle, local_port, status) = spawn_tunnel(
                &connect_host,
                connect_port,
                &hop.host,
                hop.port,
                &hop.user,
                &hop.password,
                &hop.key_path,
                &hop.key_passphrase,
                hop.use_ssh_agent,
                &hop.ssh_agent_sock_path,
                &hop.ssh_agent_key_fingerprint,
                &hop.auth_method,
                effective_hop_timeout(hop),
                &self.known_hosts_path,
                &target_host,
                target_port,
                is_last && hop.expose_lan,
                hop.allow_exec_channel_proxy,
                None,
                &hop.proxy_command,
            )
            .await
            .map_err(|err| format!("SSH hop {} failed: {err}", index + 1))?;

            handles.push(AbortOnDropHandle::new(handle));
            statuses.push(status);
            final_local_port = local_port;
            next_connect_endpoint = Some(("127.0.0.1".to_string(), local_port));
        }

        let mut tunnels = self.tunnels.lock().await;
        tunnels.insert(
            connection_id.to_string(),
            TunnelEntry {
                handles: handles.into_iter().map(AbortOnDropHandle::detach).collect(),
                statuses,
                local_port: final_local_port,
                kind: TunnelKind::Fixed,
            },
        );
        Ok(final_local_port)
    }

    /// Returns the local port for a cached tunnel entry, or `None` if there is
    /// none, it is stale, or its SSH session is known to be dead.
    ///
    /// Mirrors the staleness/failure handling in [`Self::get_active_port`] (but
    /// ignores `TunnelKind`, matching this method's existing kind-agnostic
    /// contract) so that a caller checking "is there already a usable tunnel
    /// for this connection" can't be handed a port with no live SSH session
    /// behind it — the same bug this fix closes for `start_tunnel` et al.
    pub async fn local_port(&self, connection_id: &str) -> Option<u16> {
        let (local_port, evicted) = {
            let mut tunnels = self.tunnels.lock().await;
            let entry = tunnels.get(connection_id)?;
            let is_dead = entry.handles.iter().all(|h| h.is_finished())
                || entry.statuses.iter().any(|status| status.failure().is_some());
            if is_dead {
                (None, tunnels.remove(connection_id))
            } else {
                (Some(entry.local_port), None)
            }
        };
        if let Some(entry) = evicted {
            abort_and_join(entry.handles).await;
        }
        local_port
    }

    pub async fn stop_tunnel(&self, connection_id: &str) {
        let start_lock = self.start_lock(connection_id).await;
        let _start_guard = start_lock.lock().await;

        let removed = self.tunnels.lock().await.remove(connection_id);
        if let Some(entry) = removed {
            abort_and_join(entry.handles).await;
        }

        let mut start_locks = self.start_locks.lock().await;
        let is_idle = start_locks.get(connection_id).is_some_and(|current| Arc::ptr_eq(current, &start_lock))
            && Arc::strong_count(&start_lock) == 2;
        if is_idle {
            start_locks.remove(connection_id);
        }
    }

    pub async fn stop_tunnels_with_prefix(&self, connection_id_prefix: &str) {
        let keys: Vec<String> =
            self.tunnels.lock().await.keys().filter(|key| key.starts_with(connection_id_prefix)).cloned().collect();
        for key in keys {
            self.stop_tunnel(&key).await;
        }
    }

    pub async fn stop_all_tunnels(&self) {
        let tunnels = std::mem::take(&mut *self.tunnels.lock().await);
        abort_and_join(tunnels.into_values().flat_map(|entry| entry.handles).collect()).await;
        self.start_locks.lock().await.clear();
    }
}

/// Aborts tunnel tasks and waits until they are dropped. A task owns its
/// `TcpListener`, so returning before that happens lets a caller that rebinds
/// the same fixed local port right away hit `EADDRINUSE`.
async fn abort_and_join(handles: Vec<JoinHandle<()>>) {
    for handle in &handles {
        handle.abort();
    }
    for handle in handles {
        let _ = handle.await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_tunnel(
    connect_host: &str,
    connect_port: u16,
    host_key_host: &str,
    host_key_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    ssh_agent_key_fingerprint: &str,
    auth_method: &str,
    connect_timeout_secs: u64,
    known_hosts_path: &Path,
    remote_host: &str,
    remote_port: u16,
    expose_to_lan: bool,
    allow_exec_channel_proxy: bool,
    requested_local_port: Option<u16>,
    proxy_command: &str,
) -> Result<(JoinHandle<()>, u16, Arc<TunnelStatus>), String> {
    spawn_tunnel_target(
        connect_host,
        connect_port,
        host_key_host,
        host_key_port,
        ssh_user,
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        use_ssh_agent,
        ssh_agent_sock_path,
        ssh_agent_key_fingerprint,
        auth_method,
        connect_timeout_secs,
        known_hosts_path,
        TunnelTarget::Fixed { host: remote_host.to_string(), port: remote_port },
        expose_to_lan,
        allow_exec_channel_proxy,
        requested_local_port,
        proxy_command,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn spawn_socks5_proxy(
    connect_host: &str,
    connect_port: u16,
    host_key_host: &str,
    host_key_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    ssh_agent_key_fingerprint: &str,
    auth_method: &str,
    connect_timeout_secs: u64,
    known_hosts_path: &Path,
    allow_exec_channel_proxy: bool,
    proxy_command: &str,
) -> Result<(JoinHandle<()>, u16, Arc<TunnelStatus>), String> {
    spawn_tunnel_target(
        connect_host,
        connect_port,
        host_key_host,
        host_key_port,
        ssh_user,
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        use_ssh_agent,
        ssh_agent_sock_path,
        ssh_agent_key_fingerprint,
        auth_method,
        connect_timeout_secs,
        known_hosts_path,
        TunnelTarget::Socks5,
        false,
        allow_exec_channel_proxy,
        None,
        proxy_command,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn spawn_tunnel_target(
    connect_host: &str,
    connect_port: u16,
    host_key_host: &str,
    host_key_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    ssh_agent_key_fingerprint: &str,
    auth_method: &str,
    connect_timeout_secs: u64,
    known_hosts_path: &Path,
    target: TunnelTarget,
    expose_to_lan: bool,
    allow_exec_channel_proxy: bool,
    requested_local_port: Option<u16>,
    proxy_command: &str,
) -> Result<(JoinHandle<()>, u16, Arc<TunnelStatus>), String> {
    let (listener, local_port) = bind_tunnel_listener(expose_to_lan, requested_local_port).await?;

    // Initial connection: fail fast on bad credentials
    let session = connect_and_authenticate(
        connect_host,
        connect_port,
        host_key_host,
        host_key_port,
        ssh_user,
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        use_ssh_agent,
        ssh_agent_sock_path,
        ssh_agent_key_fingerprint,
        auth_method,
        connect_timeout_secs,
        known_hosts_path,
        proxy_command,
    )
    .await?;

    let status = Arc::new(TunnelStatus::new_connected());
    let handle = tokio::spawn(tunnel_reconnect_loop(
        session,
        connect_host.to_string(),
        connect_port,
        host_key_host.to_string(),
        host_key_port,
        ssh_user.to_string(),
        ssh_password.to_string(),
        ssh_key_path.to_string(),
        ssh_key_passphrase.to_string(),
        use_ssh_agent,
        ssh_agent_sock_path.to_string(),
        ssh_agent_key_fingerprint.to_string(),
        auth_method.to_string(),
        connect_timeout_secs,
        known_hosts_path.to_path_buf(),
        listener,
        target,
        allow_exec_channel_proxy,
        status.clone(),
        proxy_command.to_string(),
    ));

    #[cfg(test)]
    let _ = SPAWNED_TUNNELS.try_with(|observer| observer.send((local_port, handle.abort_handle())));

    Ok((handle, local_port, status))
}

async fn bind_tunnel_listener(
    expose_to_lan: bool,
    requested_local_port: Option<u16>,
) -> Result<(TcpListener, u16), String> {
    let local_port = match requested_local_port {
        Some(port) => port,
        None => portpicker::pick_unused_port().ok_or("No available port")?,
    };

    let bind_addr = if expose_to_lan { "0.0.0.0" } else { "127.0.0.1" };
    let bind_error = |error: std::io::Error| {
        if requested_local_port.is_some() {
            format!("Failed to bind requested local port {local_port}: {error}")
        } else {
            format!("Failed to bind local port: {error}")
        }
    };
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        target_os = "dragonfly"
    ))]
    if requested_local_port.is_some() {
        probe_sibling_bind_address(bind_addr, local_port).map_err(bind_error)?;
    }
    let listener = TcpListener::bind((bind_addr, local_port)).await.map_err(bind_error)?;
    Ok((listener, local_port))
}

/// BSD and macOS let a bind succeed next to a listener on the other of
/// `127.0.0.1` / `0.0.0.0` for the same port once SO_REUSEADDR is set, which
/// tokio always does. A requested port would then be taken silently and traffic
/// for one address would reach the wrong listener. Binding the sibling address
/// first makes that conflict fail the way it does on Linux. The probe only
/// binds, so it never accepts a connection.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "dragonfly"
))]
fn probe_sibling_bind_address(bind_addr: &str, port: u16) -> std::io::Result<()> {
    let sibling: std::net::Ipv4Addr =
        if bind_addr == "0.0.0.0" { std::net::Ipv4Addr::LOCALHOST } else { std::net::Ipv4Addr::UNSPECIFIED };
    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(std::net::SocketAddr::from((sibling, port)))
}

pub fn effective_hop_timeout(hop: &SshTunnelConfig) -> u64 {
    if hop.connect_timeout_secs == 0 {
        crate::models::connection::default_ssh_connect_timeout_secs()
    } else {
        hop.connect_timeout_secs
    }
}

/// Serializes every test that mutates the process-global prompt gateway. The
/// lock lives in `db::ssh_prompt` because the gateway is shared with the plugin
/// Host API, so prompt tests in other modules must take the same lock. Test-only.
#[cfg(test)]
fn prompt_test_lock() -> &'static tokio::sync::Mutex<()> {
    crate::db::ssh_prompt::prompt_gateway_test_lock()
}

#[cfg(test)]
fn plan_chain(
    hops: &[SshTunnelConfig],
    remote_host: &str,
    remote_port: u16,
    local_ports: &[u16],
) -> Vec<PlannedTunnel> {
    let mut planned = Vec::new();
    let mut next_connect_endpoint: Option<(String, u16)> = None;
    for (index, hop) in hops.iter().enumerate() {
        let is_last = index + 1 == hops.len();
        let (connect_host, connect_port) =
            next_connect_endpoint.clone().unwrap_or_else(|| (hop.host.clone(), hop.port));
        let (target_host, target_port) = if is_last {
            (remote_host.to_string(), remote_port)
        } else {
            (hops[index + 1].host.clone(), hops[index + 1].port)
        };
        planned.push(PlannedTunnel {
            connect_host,
            connect_port,
            host_key_host: hop.host.clone(),
            host_key_port: hop.port,
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
    use super::prompt_test_lock;
    #[cfg(unix)]
    use super::resolve_ssh_agent_socket_path;
    use super::SshClient;
    use super::{
        abort_and_join, agent_attempts_stopped_error, bind_tunnel_listener, classify_agent_attempt,
        connect_and_authenticate, describe_terminal_auth_failure, effective_hop_timeout, netcat_proxy_command,
        normalize_ssh_fingerprint, openssh_padding_len, plan_chain, read_ssh_string,
        sanitize_unencrypted_openssh_comment_bytes, server_offers_keyboard_interactive, server_offers_password,
        ssh_client_config, tofu_prompt_deadline, AgentAttempt, HostKeyState, HostKeyVerifier, PlannedTunnel,
        TunnelEntry, TunnelKind, TunnelManager, TunnelStatus, TOFU_PROMPT_TIMEOUT,
    };
    use super::{windows_ssh_agent_endpoints, WindowsSshAgentEndpoint, WINDOWS_OPENSSH_AGENT_PIPE};
    use crate::db::http_tunnel::HttpTunnelManager;
    use crate::db::proxy_tunnel::ProxyTunnelManager;
    use crate::db::ssh_prompt;
    use crate::db::transport_layer_tunnel::{start_transport_layers_with_final_ssh_local_port, stop_transport_layers};
    use crate::models::connection::{default_ssh_connect_timeout_secs, SshTunnelConfig, TransportLayerConfig};
    use russh::client;
    use russh::client::{AuthResult, Handler};
    use russh::keys::decode_secret_key;
    use russh::keys::ssh_key::PublicKey;
    use russh::server::{self, Auth, Response, Server};
    use russh::MethodKind;
    use russh::MethodSet;
    use russh::{Channel, ChannelId};
    use std::borrow::Cow;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;
    use tokio::time::{Duration, Instant};

    #[cfg(unix)]
    #[test]
    fn ssh_agent_socket_path_expands_current_user_home() {
        let home = std::env::var("HOME").expect("HOME should be set on Unix test environments");

        assert_eq!(resolve_ssh_agent_socket_path("~/.ssh/agent.sock"), format!("{home}/.ssh/agent.sock"));
    }

    #[cfg(unix)]
    #[test]
    fn ssh_agent_socket_path_preserves_absolute_path() {
        assert_eq!(resolve_ssh_agent_socket_path("/tmp/agent.sock"), "/tmp/agent.sock");
    }

    #[cfg(all(unix, not(target_os = "redox")))]
    #[test]
    fn ssh_agent_socket_path_expands_named_user_home() {
        let user = nix::unistd::User::from_uid(nix::unistd::getuid())
            .expect("current Unix user lookup should succeed")
            .expect("current Unix user should exist in the account database");
        let home = user.dir.into_os_string().into_string().expect("current Unix user home should be valid UTF-8");

        assert_eq!(
            resolve_ssh_agent_socket_path(&format!("~{}/.ssh/agent.sock", user.name)),
            format!("{home}/.ssh/agent.sock")
        );
    }

    #[test]
    fn windows_ssh_agent_defaults_to_openssh_then_pageant() {
        assert_eq!(
            windows_ssh_agent_endpoints(""),
            vec![
                WindowsSshAgentEndpoint::NamedPipe(WINDOWS_OPENSSH_AGENT_PIPE.to_string()),
                WindowsSshAgentEndpoint::Pageant,
            ]
        );
    }

    #[test]
    fn windows_ssh_agent_uses_only_the_configured_pipe() {
        assert_eq!(
            windows_ssh_agent_endpoints(r"  \\.\pipe\custom-agent  "),
            vec![WindowsSshAgentEndpoint::NamedPipe(r"\\.\pipe\custom-agent".to_string())]
        );
    }

    #[test]
    fn normalizes_ssh_fingerprint_forms() {
        let expected = "SHA256:ABC+/DEF";
        assert_eq!(normalize_ssh_fingerprint("SHA256:abc+/def="), expected);
        assert_eq!(normalize_ssh_fingerprint("  sha256:abc+/def  "), expected);
        assert_eq!(normalize_ssh_fingerprint("SHA256_abc+/def"), expected);
        assert_eq!(normalize_ssh_fingerprint("SHA256_ABC+/DEF"), expected);
        assert_eq!(normalize_ssh_fingerprint(" MD5:aa:bb "), "MD5:aa:bb");
        assert_eq!(normalize_ssh_fingerprint(""), "");
    }

    #[test]
    fn classifies_every_agent_attempt_outcome() {
        assert_eq!(classify_agent_attempt(&Ok(AuthResult::Success)), AgentAttempt::Success);

        let keyboard_interactive = AuthResult::Failure {
            remaining_methods: MethodSet::from(&[MethodKind::KeyboardInteractive][..]),
            partial_success: false,
        };
        assert_eq!(classify_agent_attempt(&Ok(keyboard_interactive)), AgentAttempt::KeyboardInteractiveRequired);

        let password_still_offered = AuthResult::Failure {
            remaining_methods: MethodSet::from(&[MethodKind::Password][..]),
            partial_success: false,
        };
        assert_eq!(classify_agent_attempt(&Ok(password_still_offered)), AgentAttempt::Continue);

        let exhausted = AuthResult::Failure { remaining_methods: MethodSet::empty(), partial_success: false };
        assert_eq!(classify_agent_attempt(&Ok(exhausted)), AgentAttempt::ServerClosedAuthentication);

        assert_eq!(
            classify_agent_attempt(&Err(russh::AgentAuthError::Send(russh::SendError {}))),
            AgentAttempt::ConnectionLost
        );
    }

    #[test]
    fn stopped_agent_error_reports_attempted_and_total_counts() {
        let without_filter = agent_attempts_stopped_error(6, 17, "", true);
        assert!(without_filter.contains("6 of the 17"), "{without_filter}");
        assert!(without_filter.contains("Select the matching agent key"), "{without_filter}");

        let with_filter = agent_attempts_stopped_error(1, 17, "SHA256:abc", false);
        assert!(with_filter.contains("1 of the 17"), "{with_filter}");
        assert!(with_filter.contains("SHA256:abc"), "{with_filter}");
    }

    #[test]
    fn tofu_prompt_deadline_uses_the_actual_prompt_start() {
        let now = Instant::now();
        let network_deadline = now + Duration::from_secs(10);
        let prompt_started_at = now + Duration::from_secs(4);

        assert_eq!(
            tofu_prompt_deadline(network_deadline, prompt_started_at),
            Some(prompt_started_at + TOFU_PROMPT_TIMEOUT)
        );
    }

    #[test]
    fn tofu_prompt_deadline_does_not_revive_an_expired_network_budget() {
        let now = Instant::now();
        let network_deadline = now + Duration::from_secs(10);

        assert_eq!(tofu_prompt_deadline(network_deadline, network_deadline), None);
        assert_eq!(tofu_prompt_deadline(network_deadline, network_deadline + Duration::from_millis(1)), None);
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn push_ssh_string(bytes: &mut Vec<u8>, value: &[u8]) {
        push_u32(bytes, value.len() as u32);
        bytes.extend_from_slice(value);
    }

    fn padded_private_blob(comment: &[u8]) -> Vec<u8> {
        let mut blob = Vec::new();
        push_u32(&mut blob, 7);
        push_u32(&mut blob, 7);
        blob.extend_from_slice(b"fake-private-key");
        push_ssh_string(&mut blob, comment);
        for value in 1..=(8 - (blob.len() % 8)) {
            blob.push(value as u8);
        }
        blob
    }

    fn openssh_container(private_blob: &[u8]) -> Vec<u8> {
        let mut bytes = b"openssh-key-v1\0".to_vec();
        push_ssh_string(&mut bytes, b"none");
        push_ssh_string(&mut bytes, b"none");
        push_ssh_string(&mut bytes, b"");
        push_u32(&mut bytes, 1);
        push_ssh_string(&mut bytes, b"fake-public-key");
        push_ssh_string(&mut bytes, private_blob);
        bytes
    }

    #[tokio::test]
    async fn requested_local_port_is_bound_exactly() {
        let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let (listener, local_port) = bind_tunnel_listener(false, Some(port)).await.unwrap();

        assert_eq!(local_port, port);
        assert_eq!(listener.local_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn requested_local_port_conflict_is_reported() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = occupied.local_addr().unwrap().port();

        let error = bind_tunnel_listener(false, Some(port)).await.unwrap_err();

        assert!(error.contains(&format!("requested local port {port}")));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn requested_local_port_conflicts_with_a_listener_on_the_sibling_address() {
        // (label, address another listener already holds, expose_to_lan, expect a conflict)
        let cases = [
            ("free port, loopback bind", None, false, false),
            ("free port, LAN bind", None, true, false),
            ("same loopback address", Some("127.0.0.1"), false, true),
            ("wildcard listener under a loopback bind", Some("0.0.0.0"), false, true),
            ("loopback listener under a LAN bind", Some("127.0.0.1"), true, true),
        ];

        for (label, held_address, expose_to_lan, expect_conflict) in cases {
            let (holder, port) = match held_address {
                Some(address) => {
                    let holder = std::net::TcpListener::bind((address, 0)).unwrap();
                    let port = holder.local_addr().unwrap().port();
                    (Some(holder), port)
                }
                None => (None, free_local_port().await),
            };

            let bound = bind_tunnel_listener(expose_to_lan, Some(port)).await;

            match (bound, expect_conflict) {
                (Ok((_listener, local_port)), false) => assert_eq!(local_port, port, "{label}"),
                (Err(error), true) => {
                    assert!(error.contains(&format!("Failed to bind requested local port {port}")), "{label}: {error}")
                }
                (Ok(_), true) => panic!("{label}: the bind should have failed"),
                (Err(error), false) => panic!("{label}: the bind should have succeeded: {error}"),
            }
            drop(holder);
        }
    }

    fn hop(id: &str, host: &str, port: u16) -> SshTunnelConfig {
        SshTunnelConfig {
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
        }
    }

    #[test]
    fn chain_plan_routes_each_hop_to_next_endpoint() {
        let hops = vec![hop("a", "bastion-a", 22), hop("b", "bastion-b", 2200)];

        let planned = plan_chain(&hops, "db.internal", 5432, &[41001, 41002]);

        assert_eq!(
            planned,
            vec![
                PlannedTunnel {
                    connect_host: "bastion-a".to_string(),
                    connect_port: 22,
                    host_key_host: "bastion-a".to_string(),
                    host_key_port: 22,
                    remote_host: "bastion-b".to_string(),
                    remote_port: 2200,
                },
                PlannedTunnel {
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41001,
                    host_key_host: "bastion-b".to_string(),
                    host_key_port: 2200,
                    remote_host: "db.internal".to_string(),
                    remote_port: 5432,
                },
            ]
        );
    }

    #[test]
    fn zero_hop_timeout_uses_default() {
        let mut tunnel = hop("a", "bastion-a", 22);
        tunnel.connect_timeout_secs = 0;

        assert_eq!(effective_hop_timeout(&tunnel), default_ssh_connect_timeout_secs());
    }

    #[test]
    fn ssh_client_config_moves_extension_markers_to_kex_tail() {
        let config = ssh_client_config();
        let kex = config.preferred.kex;
        let len = kex.len();
        let position = |needle: russh::kex::Name| kex.iter().position(|algorithm| *algorithm == needle).unwrap();

        // In the config proposal the four extension markers occupy the last
        // four slots, in the same relative order russh ships them. On the wire
        // russh's write_kex filters out the two server-role markers, so only
        // the client-role pair (ext-info-c, kex-strict-c-v00@openssh.com)
        // actually reaches the server.
        assert_eq!(kex[len - 4], russh::kex::EXTENSION_SUPPORT_AS_CLIENT);
        assert_eq!(kex[len - 3], russh::kex::EXTENSION_SUPPORT_AS_SERVER);
        assert_eq!(kex[len - 2], russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT);
        assert_eq!(kex[len - 1], russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER);

        // Every key-exchange algorithm that actually performs a DH/ECDH
        // exchange stays ahead of the markers, so a server scanning the offer
        // left-to-right still selects a real exchange before reaching them.
        let nistp256_index = position(russh::kex::ECDH_SHA2_NISTP256);
        let group14_sha1_index = position(russh::kex::DH_G14_SHA1);
        assert!(nistp256_index < len - 4);
        assert!(group14_sha1_index < len - 4);
    }

    #[test]
    fn ssh_client_config_keeps_each_extension_marker_once() {
        let config = ssh_client_config();
        let kex = config.preferred.kex;
        for marker in [
            russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
            russh::kex::EXTENSION_SUPPORT_AS_SERVER,
            russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
            russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
        ] {
            // Relocation must not duplicate (retain + extend, not append-only).
            assert_eq!(
                kex.iter().filter(|algorithm| **algorithm == marker).count(),
                1,
                "extension marker appears more than once: {marker:?}"
            );
        }
    }

    #[test]
    fn ssh_client_config_keeps_legacy_cbc_ciphers_after_safe_defaults() {
        let config = ssh_client_config();
        let ciphers = config.preferred.cipher;
        let position = |needle: russh::cipher::Name| ciphers.iter().position(|algorithm| *algorithm == needle).unwrap();

        // A CBC-only daemon (issue #9397 offered aes256-cbc/aes128-cbc and
        // nothing else) only finds a common cipher through these fallbacks.
        let aes256_cbc_index = position(russh::cipher::AES_256_CBC);
        let aes128_cbc_index = position(russh::cipher::AES_128_CBC);
        let gcm_index = position(russh::cipher::AES_256_GCM);
        let ctr_index = position(russh::cipher::AES_128_CTR);

        // Every safe default stays ahead of CBC, so a capable server still
        // negotiates a modern cipher.
        assert!(gcm_index < aes256_cbc_index);
        assert!(ctr_index < aes256_cbc_index);
        assert!(aes256_cbc_index < aes128_cbc_index);
    }

    #[test]
    fn ssh_client_config_keeps_legacy_kex_after_safe_defaults() {
        let config = ssh_client_config();
        let kex = config.preferred.kex;
        let curve25519_index = kex.iter().position(|algorithm| *algorithm == russh::kex::CURVE25519).unwrap();
        let ecdh_index = kex.iter().position(|algorithm| *algorithm == russh::kex::ECDH_SHA2_NISTP256).unwrap();
        let group14_sha1_index = kex.iter().position(|algorithm| *algorithm == russh::kex::DH_G14_SHA1).unwrap();

        assert!(curve25519_index < ecdh_index);
        assert!(ecdh_index < group14_sha1_index);
    }

    #[test]
    fn ssh_client_config_offers_sha1_group_exchange_kex_last() {
        let config = ssh_client_config();
        let kex = config.preferred.kex;
        let position = |needle: russh::kex::Name| kex.iter().position(|algorithm| *algorithm == needle).unwrap();

        // A server advertising only the two SHA-1 exchanges from issue #8722 has
        // to find a common algorithm, or the handshake fails before auth.
        let gex_sha1_index = position(russh::kex::DH_GEX_SHA1);
        let group1_sha1_index = position(russh::kex::DH_G1_SHA1);

        // Both stay behind every safe default, including the SHA-1 fallback that
        // was already present, so a capable server never downgrades to them.
        let group14_sha1_index = position(russh::kex::DH_G14_SHA1);
        let gex_sha256_index = position(russh::kex::DH_GEX_SHA256);

        assert!(gex_sha256_index < group14_sha1_index);
        assert!(group14_sha1_index < gex_sha1_index);
        assert!(gex_sha1_index < group1_sha1_index);
    }

    #[test]
    fn ssh_client_config_lowers_group_exchange_minimum_for_legacy_servers() {
        let config = ssh_client_config();

        // russh's 3072-bit default minimum is rejected by the legacy daemons
        // that need DH_GEX_SHA1 in the first place, which would leave the new
        // fallback unusable.
        assert_eq!(config.gex.min_group_size(), 2048);
        assert_eq!(config.gex.preferred_group_size(), russh::client::GexParams::default().preferred_group_size());
        assert_eq!(config.gex.max_group_size(), russh::client::GexParams::default().max_group_size());
    }

    #[test]
    fn ssh_client_config_keeps_legacy_mac_after_safe_defaults() {
        let config = ssh_client_config();
        let mac = config.preferred.mac;
        let sha2_etm_index = mac.iter().position(|algorithm| *algorithm == russh::mac::HMAC_SHA256_ETM).unwrap();
        let sha1_etm_index = mac.iter().position(|algorithm| *algorithm == russh::mac::HMAC_SHA1_ETM).unwrap();
        let sha1_index = mac.iter().position(|algorithm| *algorithm == russh::mac::HMAC_SHA1).unwrap();

        assert!(sha2_etm_index < sha1_etm_index);
        assert!(sha1_etm_index < sha1_index);
    }

    #[test]
    fn sanitizes_invalid_openssh_private_key_comment() {
        let mut key = openssh_container(&padded_private_blob(&[0xff, 0xfe, b'a']));

        sanitize_unencrypted_openssh_comment_bytes(&mut key).unwrap();

        let mut pos = b"openssh-key-v1\0".len();
        assert_eq!(read_ssh_string(&key, &mut pos).unwrap(), b"none");
        let _kdfname = read_ssh_string(&key, &mut pos).unwrap();
        let _kdfoptions = read_ssh_string(&key, &mut pos).unwrap();
        pos += 4;
        let _public_key = read_ssh_string(&key, &mut pos).unwrap();
        let private_blob = read_ssh_string(&key, &mut pos).unwrap();
        let unpadded_end = private_blob.len() - openssh_padding_len(private_blob).unwrap();
        let comment_len_pos = unpadded_end - 4;

        assert_eq!(&private_blob[comment_len_pos..unpadded_end], &0u32.to_be_bytes());
    }

    #[tokio::test]
    async fn local_port_reuses_existing_chain_entry() {
        let manager = TunnelManager::new(std::env::temp_dir().to_path_buf());

        assert_eq!(manager.local_port("missing").await, None);
        manager.stop_tunnel("missing").await;
    }

    #[tokio::test]
    async fn local_port_hides_a_tunnel_with_a_recorded_failure() {
        // `local_port` used to hand back the cached port unconditionally,
        // bypassing the same failure tracking `get_active_port` uses. A caller
        // relying on it to decide "is there already a usable tunnel" (e.g. to
        // avoid starting a redundant one) could be handed a port with no live
        // SSH session behind it, reproducing the bug this fix closes.
        let manager = TunnelManager::new(std::env::temp_dir().to_path_buf());

        let status = Arc::new(TunnelStatus::new_connected());
        status.record_failure("SSH public key authentication failed".to_string());
        // A handle that never finishes, so the entry is only excluded by the
        // recorded failure below, not by the unrelated staleness check.
        let handle = tokio::spawn(std::future::pending::<()>());

        manager.tunnels.lock().await.insert(
            "conn".to_string(),
            TunnelEntry { handles: vec![handle], statuses: vec![status], local_port: 54321, kind: TunnelKind::Fixed },
        );

        assert_eq!(manager.local_port("conn").await, None);
        // The dead entry is also cleared out, same as get_active_port does.
        assert!(!manager.tunnels.lock().await.contains_key("conn"));
    }

    #[tokio::test]
    async fn successful_reconnect_clears_failure_before_port_reuse() {
        let status = Arc::new(TunnelStatus::new_connected());
        status.record_failure("SSH public key authentication failed".to_string());
        status.mark_connected();
        let handle = tokio::spawn(std::future::pending::<()>());
        let mut tunnels = std::collections::HashMap::from([(
            "conn".to_string(),
            TunnelEntry { handles: vec![handle], statuses: vec![status], local_port: 54321, kind: TunnelKind::Fixed },
        )]);

        let mut evicted = Vec::new();

        assert_eq!(
            TunnelManager::get_active_port(&mut tunnels, "conn", TunnelKind::Fixed, &mut evicted),
            Ok(Some(54321))
        );
        assert!(tunnels.contains_key("conn"));
        assert!(evicted.is_empty());
    }

    #[tokio::test]
    async fn healthy_port_reports_only_usable_entries_and_never_evicts() {
        let failed = Arc::new(TunnelStatus::new_connected());
        failed.record_failure("SSH public key authentication failed".to_string());
        let finished = tokio::spawn(async {});
        while !finished.is_finished() {
            tokio::task::yield_now().await;
        }

        // (label, handle, status, kind, expected port)
        let cases = [
            (
                "healthy",
                tokio::spawn(std::future::pending::<()>()),
                Arc::new(TunnelStatus::new_connected()),
                TunnelKind::Fixed,
                Some(54321),
            ),
            ("recorded failure", tokio::spawn(std::future::pending::<()>()), failed, TunnelKind::Fixed, None),
            ("every task finished", finished, Arc::new(TunnelStatus::new_connected()), TunnelKind::Fixed, None),
            (
                "other kind",
                tokio::spawn(std::future::pending::<()>()),
                Arc::new(TunnelStatus::new_connected()),
                TunnelKind::Socks5,
                None,
            ),
        ];

        for (label, handle, status, kind, expected) in cases {
            let mut tunnels = std::collections::HashMap::from([(
                "conn".to_string(),
                TunnelEntry { handles: vec![handle], statuses: vec![status], local_port: 54321, kind },
            )]);

            assert_eq!(TunnelManager::healthy_port(&tunnels, "conn", TunnelKind::Fixed), expected, "{label}");
            assert!(tunnels.contains_key("conn"), "{label}");
            for entry in tunnels.drain().map(|(_, entry)| entry) {
                abort_and_join(entry.handles).await;
            }
        }
    }

    #[tokio::test]
    async fn evicting_a_failed_tunnel_releases_its_local_port_before_the_error_is_returned() {
        let manager = TunnelManager::new(std::env::temp_dir().to_path_buf());
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = Arc::new(TunnelStatus::new_connected());
        status.record_failure("SSH tunnel lost its session and could not reconnect".to_string());
        // The reconnect loop keeps its listener while it backs off, so the task does too.
        let handle = tokio::spawn(async move {
            let _listener = listener;
            std::future::pending::<()>().await;
        });
        manager.tunnels.lock().await.insert(
            "fixed-port".to_string(),
            TunnelEntry { handles: vec![handle], statuses: vec![status], local_port: port, kind: TunnelKind::Fixed },
        );

        let error = start_echo_tunnel(&manager, 22, Some(port)).await.unwrap_err();

        assert!(error.contains("could not reconnect"), "{error}");
        assert!(!manager.tunnels.lock().await.contains_key("fixed-port"));
        std::net::TcpListener::bind(("127.0.0.1", port)).expect("the evicted tunnel must have released its port");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_status_transitions_never_expose_a_torn_state() {
        // Regression guard for the race flagged in review: the old design
        // published `connected` (`AtomicBool`) and `last_error`
        // (`Mutex<Option<String>>`) as two independent writes, so a reader
        // could land in the gap and observe `connected = false` with
        // `last_error` still `None` — i.e. "healthy" — while the tunnel had
        // actually just failed, and hand back a dead local port.
        // `TunnelHealth` folds both into one enum behind a single lock, so
        // every transition is one atomic write and that gap cannot exist by
        // construction.
        //
        // A true happens-before proof of a nanosecond-scale memory-ordering
        // race needs tooling like loom, which this crate doesn't depend on;
        // real OS threads can't *guarantee* they hit it. This test instead
        // hammers the same interleaving — readers spinning on `failure()`
        // while a writer races disconnect -> fail -> reconnect — on real
        // parallel threads many times, and asserts every read is a value the
        // writer could actually have produced, never something assembled
        // from two different transitions.
        let status = Arc::new(TunnelStatus::new_connected());
        let stop = Arc::new(AtomicBool::new(false));
        let saw_unexpected = Arc::new(AtomicBool::new(false));

        let mut readers = Vec::new();
        for _ in 0..8 {
            let status = status.clone();
            let stop = stop.clone();
            let saw_unexpected = saw_unexpected.clone();
            readers.push(tokio::spawn(async move {
                while !stop.load(Ordering::SeqCst) {
                    if let Some(reason) = status.failure() {
                        if !reason.starts_with("attempt ") || !reason.ends_with(" refused") {
                            saw_unexpected.store(true, Ordering::SeqCst);
                        }
                    }
                }
            }));
        }

        for i in 0..20_000u32 {
            status.mark_connected();
            status.mark_disconnected();
            status.record_failure(format!("attempt {i} refused"));
        }

        stop.store(true, Ordering::SeqCst);
        for reader in readers {
            reader.await.unwrap();
        }

        assert!(
            !saw_unexpected.load(Ordering::SeqCst),
            "a reader observed a failure reason that record_failure never set — status must publish atomically"
        );
    }

    // --- Host-key verification (MITM hardening) ---------------------------------

    /// Builds the public key embedded in [`TEST_SERVER_KEY_PEM`]. The comment
    /// is cleared so it matches the comment-less key parsed back from the
    /// known_hosts file (real server keys presented during KEX carry no
    /// comment, so this mirrors production behaviour).
    fn test_server_public_key() -> PublicKey {
        let mut key =
            decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key").public_key().clone();
        key.set_comment("");
        key
    }

    #[test]
    fn tofu_unknown_host_check_then_learn_records_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());

        let key = test_server_public_key();
        // Unknown host -> candidate for explicit TOFU (not silently trusted).
        assert_eq!(verifier.check("db.example.com", 22, &key).unwrap(), HostKeyState::Unknown);
        // User accepts -> record it via learn().
        verifier.learn("db.example.com", 22, &key).unwrap();
        // Second contact with the same key is now trusted (read back from file).
        assert_eq!(verifier.check("db.example.com", 22, &key).unwrap(), HostKeyState::Trusted);
        // And the key really landed in the store.
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("db.example.com"), "recorded host missing: {contents}");
    }

    #[test]
    fn changed_host_key_is_reported() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        // Pre-seed the store with a *different* (valid) ed25519 key for the host.
        std::fs::write(
            &path,
            "db.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X\n",
        )
        .unwrap();
        let verifier = HostKeyVerifier::new(path);

        // The server actually presents TEST_SERVER_KEY_PEM's key -> mismatch.
        let key = test_server_public_key();
        match verifier.check("db.example.com", 22, &key).unwrap() {
            HostKeyState::Changed { previous_fingerprint } => {
                assert!(
                    previous_fingerprint.starts_with("SHA256:"),
                    "changed key must expose the saved fingerprint, got {previous_fingerprint}"
                );
            }
            other => panic!("changed host key must be reported as Changed, got {other:?}"),
        }
    }

    #[test]
    fn replace_updates_changed_host_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(
            &path,
            "db.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X\n",
        )
        .unwrap();
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        assert!(matches!(verifier.check("db.example.com", 22, &key).unwrap(), HostKeyState::Changed { .. }));
        verifier.replace("db.example.com", 22, &key).unwrap();
        assert_eq!(verifier.check("db.example.com", 22, &key).unwrap(), HostKeyState::Trusted);
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(
            !contents.contains("AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X"),
            "old key must be removed: {contents}"
        );
        assert!(contents.contains("db.example.com"), "new key must be recorded: {contents}");
    }

    #[test]
    fn unknown_host_without_persist_permission_is_rejected() {
        let dir = tempdir().unwrap();
        // Make the would-be parent a regular file so the store can never be
        // created — this is the "no write permission" edge case.
        let frozen = dir.path().join("frozen");
        std::fs::write(&frozen, b"not a directory").unwrap();
        let verifier = HostKeyVerifier::new(frozen.join("known_hosts"));

        let key = test_server_public_key();
        // Fail-closed: the unknown host is reported as a candidate, but it
        // cannot be persisted (no write permission), so we must NOT trust it in
        // memory — learn() must error rather than silently accept.
        assert_eq!(verifier.check("db.example.com", 22, &key).unwrap(), HostKeyState::Unknown);
        assert!(
            verifier.learn("db.example.com", 22, &key).is_err(),
            "learn must fail when the store is unwritable (fail-closed)"
        );
    }

    // --- Explicit TOFU prompt bridge (HostKeyVerify) ---------------------------

    /// Spawns a fake UI gateway that answers every prompt with `answer`.
    fn install_fake_prompt_gateway(answer: ssh_prompt::SshPromptAnswer) {
        let (tx, mut rx) = mpsc::channel::<ssh_prompt::SshPromptEnvelope>(8);
        tokio::spawn(async move {
            if let Some(env) = rx.recv().await {
                let _ = env.responder.send(answer);
            }
        });
        ssh_prompt::install_ssh_prompt_gateway(tx);
    }

    #[tokio::test]
    async fn unknown_host_prompt_accept_learns_key() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Accept { remember: true });
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "accepted host key should be trusted");
        // The accepted key must be persisted when remember=true.
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("db.example.com"), "accepted key should be learned: {contents}");
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[tokio::test]
    async fn unknown_host_prompt_accept_without_remember_is_session_only() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Accept { remember: false });
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "accepted host key should be trusted for the session");
        // remember=false -> key is NOT persisted.
        assert!(
            !path.exists() || std::fs::read_to_string(&path).unwrap_or_default().is_empty(),
            "key must not be persisted when remember=false"
        );
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[tokio::test]
    async fn unknown_host_prompt_reject_aborts_handshake() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Reject);
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(!trusted, "rejected host key must not be trusted");
        // Rejected -> never persisted.
        assert!(
            !path.exists() || std::fs::read_to_string(&path).unwrap_or_default().is_empty(),
            "rejected key must not be persisted"
        );
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[tokio::test]
    async fn unknown_host_without_gateway_fails_closed() {
        let _guard = prompt_test_lock().lock().await;
        // Ensure no gateway is installed so request_ssh_prompt returns None.
        ssh_prompt::clear_ssh_prompt_gateway();
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path);
        let key = test_server_public_key();

        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };
        let trusted = client.check_server_key(&key).await.unwrap();
        // No UI to confirm -> fail-closed, host is not trusted.
        assert!(!trusted, "without a gateway, an unknown host must be rejected (fail-closed)");
    }

    #[tokio::test]
    async fn trusted_host_skips_prompt() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path);
        let key = test_server_public_key();
        // Pre-seed the store so the host is already trusted.
        verifier.learn("db.example.com", 22, &key).unwrap();

        // No gateway installed, but the host is trusted so no prompt is needed.
        ssh_prompt::clear_ssh_prompt_gateway();
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };
        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "a known-trusted host must be accepted without a prompt");
    }

    fn seed_changed_host_key(path: &std::path::Path) {
        std::fs::write(
            path,
            "db.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X\n",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn changed_host_prompt_update_replaces_key() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        seed_changed_host_key(&path);
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Accept { remember: true });
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "updating a changed host key should continue the handshake");
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(
            !contents.contains("AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X"),
            "old key must be removed: {contents}"
        );
        assert!(contents.contains("db.example.com"), "new key should be learned: {contents}");
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[tokio::test]
    async fn changed_host_prompt_continue_is_session_only() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        seed_changed_host_key(&path);
        let original = std::fs::read_to_string(&path).unwrap();
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Accept { remember: false });
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "continuing without update should trust this session");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "remember=false must leave known_hosts unchanged"
        );
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[tokio::test]
    async fn changed_host_prompt_reject_aborts_handshake() {
        let _guard = prompt_test_lock().lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        seed_changed_host_key(&path);
        let original = std::fs::read_to_string(&path).unwrap();
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Reject);
        let mut client = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "db.example.com".to_string(),
            port: 22,
            prompt_started_tx: None,
        };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(!trusted, "rejected changed host key must not be trusted");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "rejected change must not rewrite known_hosts");
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    // --- key+password fallback policy ------------------------------------------

    #[test]
    fn password_fallback_only_when_server_offers_it() {
        // Server offers only publickey: never leak the password.
        let only_key = MethodSet::from(&[MethodKind::PublicKey][..]);
        assert!(!server_offers_password(&only_key));

        // Server offers password too: safe to fall back.
        let with_pw = MethodSet::from(&[MethodKind::PublicKey, MethodKind::Password][..]);
        assert!(server_offers_password(&with_pw));

        // No methods advertised at all: do NOT send the password, even if a
        // `partial_success` flag were present — we intentionally ignore it and
        // rely solely on the advertised method list (RFC 4252 §5.1).
        let empty = MethodSet::empty();
        assert!(!server_offers_password(&empty));
    }

    #[test]
    fn detects_keyboard_interactive_auth_method() {
        let keyboard_interactive = MethodSet::from(&[MethodKind::KeyboardInteractive][..]);
        assert!(server_offers_keyboard_interactive(&keyboard_interactive));

        let password_only = MethodSet::from(&[MethodKind::Password][..]);
        assert!(!server_offers_keyboard_interactive(&password_only));
    }

    #[test]
    fn netcat_fallback_quotes_the_target_for_the_remote_shell() {
        assert_eq!(netcat_proxy_command("10.0.0.5", 5432).unwrap(), "exec nc '10.0.0.5' 5432");
        assert_eq!(netcat_proxy_command("db'prod.internal", 3306).unwrap(), "exec nc 'db'\\''prod.internal' 3306");
        assert!(netcat_proxy_command("db.internal\nmalicious-command", 5432).is_err());
    }

    // --- MITM hardening: a changed/unknown host never receives the password ---

    const TEST_SERVER_KEY_PEM: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAVDlhwKBk+QMZN+WNAUKL6qLr3hf3S5p1TdSK4hMhLxwAAAJD9wI28/cCN
vAAAAAtzc2gtZWQyNTUxOQAAACAVDlhwKBk+QMZN+WNAUKL6qLr3hf3S5p1TdSK4hMhLxw
AAAEDxqdMQX37UdhziSi5Br3kyRM/Xrpo9ZcXoguYkeogq0hUOWHAoGT5Axk35Y0BQovqo
uveF/dLmnVN1IriEyEvHAAAACGRieC10ZXN0AQIDBAU=
-----END OPENSSH PRIVATE KEY-----"#;

    struct PasswordThenTotpServer;

    impl server::Server for PasswordThenTotpServer {
        type Handler = PasswordThenTotpHandler;

        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> PasswordThenTotpHandler {
            PasswordThenTotpHandler
        }
    }

    struct PasswordThenTotpHandler;

    impl server::Handler for PasswordThenTotpHandler {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
            if password == "secret" {
                Ok(Auth::Reject {
                    proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                    partial_success: true,
                })
            } else {
                Ok(Auth::reject())
            }
        }

        async fn auth_publickey(
            &mut self,
            _user: &str,
            _public_key: &russh::keys::ssh_key::PublicKey,
        ) -> Result<Auth, Self::Error> {
            Ok(Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                partial_success: true,
            })
        }

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _user: &str,
            _submethods: &str,
            mut response: Option<Response<'a>>,
        ) -> Result<Auth, Self::Error> {
            let Some(ref mut answers) = response else {
                return Ok(Auth::Partial {
                    name: Cow::Borrowed("JumpServer"),
                    instructions: Cow::Borrowed("Multi-factor authentication"),
                    prompts: Cow::Owned(vec![(Cow::Borrowed("OTP Code: "), false)]),
                });
            };

            if answers.next().as_deref() == Some(b"123456") {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::reject())
            }
        }
    }

    async fn start_password_then_totp_server() -> (u16, tokio::task::JoinHandle<()>) {
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config {
            keys: vec![server_key],
            methods: MethodSet::from(
                &[MethodKind::Password, MethodKind::PublicKey, MethodKind::KeyboardInteractive][..],
            ),
            auth_rejection_time: std::time::Duration::ZERO,
            auth_rejection_time_initial: Some(std::time::Duration::ZERO),
            ..Default::default()
        };
        let port = portpicker::pick_unused_port().expect("no free port");
        let mut server = PasswordThenTotpServer;
        let task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", port)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        (port, task)
    }

    #[tokio::test]
    async fn password_auth_continues_with_keyboard_interactive_totp() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (port, server_task) = start_password_then_totp_server().await;
        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        HostKeyVerifier::new(known_hosts_path.clone()).learn("127.0.0.1", port, &test_server_public_key()).unwrap();

        let (gateway_tx, mut gateway_rx) = mpsc::channel::<ssh_prompt::SshPromptEnvelope>(1);
        let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let envelope = gateway_rx.recv().await.expect("TOTP prompt");
            let _ = observed_tx.send((envelope.request.kind, envelope.request.prompt.clone(), envelope.request.echo));
            let _ = envelope.responder.send(ssh_prompt::SshPromptAnswer::Secret("123456".to_string()));
        });
        ssh_prompt::install_ssh_prompt_gateway(gateway_tx);

        let session = connect_and_authenticate(
            "127.0.0.1",
            port,
            "127.0.0.1",
            port,
            "user",
            "secret",
            "",
            "",
            false,
            "",
            "",
            "password",
            5,
            &known_hosts_path,
            "",
        )
        .await
        .expect("password + TOTP authentication should succeed");

        let (kind, prompt, echo) = observed_rx.await.unwrap();
        assert_eq!(kind, ssh_prompt::SshPromptKind::SecretInput);
        assert!(prompt.unwrap().contains("OTP Code"));
        assert!(!echo, "TOTP response should not be echoed");

        drop(session);
        ssh_prompt::clear_ssh_prompt_gateway();
        server_task.abort();
    }

    #[tokio::test]
    async fn public_key_auth_continues_with_keyboard_interactive_totp() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (port, server_task) = start_password_then_totp_server().await;
        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        let key_path = dir.path().join("id_ed25519");
        std::fs::write(&key_path, TEST_SERVER_KEY_PEM).unwrap();
        HostKeyVerifier::new(known_hosts_path.clone()).learn("127.0.0.1", port, &test_server_public_key()).unwrap();

        let (gateway_tx, mut gateway_rx) = mpsc::channel::<ssh_prompt::SshPromptEnvelope>(1);
        tokio::spawn(async move {
            let envelope = gateway_rx.recv().await.expect("TOTP prompt");
            let _ = envelope.responder.send(ssh_prompt::SshPromptAnswer::Secret("123456".to_string()));
        });
        ssh_prompt::install_ssh_prompt_gateway(gateway_tx);

        let session = connect_and_authenticate(
            "127.0.0.1",
            port,
            "127.0.0.1",
            port,
            "user",
            "",
            key_path.to_str().unwrap(),
            "",
            false,
            "",
            "",
            "key",
            5,
            &known_hosts_path,
            "",
        )
        .await
        .expect("public key + TOTP authentication should succeed");

        drop(session);
        ssh_prompt::clear_ssh_prompt_gateway();
        server_task.abort();
    }

    struct AcceptNoneServer;

    impl server::Server for AcceptNoneServer {
        type Handler = AcceptNoneHandler;

        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> AcceptNoneHandler {
            AcceptNoneHandler
        }
    }

    struct AcceptNoneHandler;

    impl server::Handler for AcceptNoneHandler {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }
    }

    async fn start_accept_none_server() -> (u16, tokio::task::JoinHandle<()>) {
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config { keys: vec![server_key], ..Default::default() };
        let port = portpicker::pick_unused_port().expect("no free port");
        let mut server = AcceptNoneServer;
        let task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", port)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        (port, task)
    }

    #[tokio::test]
    async fn transport_chain_later_hop_failure_closes_unregistered_listener() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (port, server_task) = start_accept_none_server().await;
        let dir = tempdir().unwrap();
        HostKeyVerifier::new(dir.path().join("known_hosts"))
            .learn("127.0.0.1", port, &test_server_public_key())
            .unwrap();
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let mut first = hop("first", "127.0.0.1", port);
        first.auth_method = "none".to_string();
        let second = hop("second", "unreachable.internal", 22);
        let (observer, mut spawned) = mpsc::unbounded_channel();
        let result = super::SPAWNED_TUNNELS
            .scope(observer, manager.start_chain("failed-chain", &[first, second], "db.internal", 5432))
            .await;
        let (local_port, abort) = spawned.recv().await.expect("first hop actually started");
        assert!(result.as_ref().is_err_and(|error| error.contains("SSH hop 2 failed")), "{result:?}");
        assert!(manager.tunnels.lock().await.is_empty());
        let closed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(listener) = TcpListener::bind(("127.0.0.1", local_port)).await {
                    drop(listener);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        abort.abort();
        server_task.abort();
        assert!(closed, "failed chain left its unregistered first-hop listener on {local_port}");
    }

    #[tokio::test]
    async fn transport_tunnel_registration_cancellation_closes_unregistered_listener() {
        let _guard = prompt_test_lock().lock().await;
        for socks in [false, true] {
            ssh_prompt::clear_ssh_prompt_gateway();
            let (port, server_task) = start_accept_none_server().await;
            let dir = tempdir().unwrap();
            let manager = Arc::new(TunnelManager::new(dir.path().to_path_buf()));
            let (gateway, mut prompts) = mpsc::channel(8);
            ssh_prompt::install_ssh_prompt_gateway(gateway);
            let (observer, mut spawned) = mpsc::unbounded_channel();
            let starting_manager = manager.clone();
            let start = tokio::spawn(super::SPAWNED_TUNNELS.scope(observer, async move {
                if socks {
                    starting_manager
                        .start_socks5_proxy(
                            "cancelled",
                            "127.0.0.1",
                            port,
                            "127.0.0.1",
                            port,
                            "user",
                            "",
                            "",
                            "",
                            false,
                            "",
                            "",
                            "none",
                            5,
                            false,
                            "",
                        )
                        .await
                } else {
                    starting_manager
                        .start_tunnel(
                            "cancelled",
                            "127.0.0.1",
                            port,
                            "127.0.0.1",
                            port,
                            "user",
                            "",
                            "",
                            "",
                            false,
                            "",
                            "",
                            "none",
                            5,
                            "db.internal",
                            5432,
                            false,
                            false,
                            "",
                        )
                        .await
                }
            }));
            let prompt = tokio::time::timeout(Duration::from_secs(5), prompts.recv()).await.unwrap().unwrap();
            let tunnels = manager.tunnels.lock().await;
            prompt.responder.send(ssh_prompt::SshPromptAnswer::Accept { remember: false }).unwrap();
            let (local_port, abort) =
                tokio::time::timeout(Duration::from_secs(5), spawned.recv()).await.unwrap().unwrap();
            assert!(!start.is_finished(), "start must be waiting for the real registration lock");
            start.abort();
            assert!(start.await.unwrap_err().is_cancelled());
            let closed = tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    if let Ok(listener) = TcpListener::bind(("127.0.0.1", local_port)).await {
                        drop(listener);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .is_ok();
            abort.abort();
            assert!(tunnels.is_empty());
            drop(tunnels);
            server_task.abort();
            ssh_prompt::clear_ssh_prompt_gateway();
            assert!(closed, "cancelled registration left listener {local_port}, socks={socks}");
        }
    }

    #[tokio::test]
    async fn transport_chain_cancellation_closes_unregistered_listener() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (port, server_task) = start_accept_none_server().await;
        let dir = tempdir().unwrap();
        HostKeyVerifier::new(dir.path().join("known_hosts"))
            .learn("127.0.0.1", port, &test_server_public_key())
            .unwrap();
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let mut first = hop("first", "127.0.0.1", port);
        first.auth_method = "none".to_string();
        let hops = [first, hop("second", "unreachable.internal", 22)];
        let (observer, mut spawned) = mpsc::unbounded_channel();
        let mut starting = Box::pin(
            super::SPAWNED_TUNNELS.scope(observer, manager.start_chain("cancelled-chain", &hops, "db.internal", 5432)),
        );
        let (local_port, abort) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                biased;
                spawned = spawned.recv() => spawned.unwrap(),
                result = &mut starting => panic!("chain ended before cancellation: {result:?}"),
            }
        })
        .await
        .unwrap();
        drop(starting);
        let closed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(listener) = TcpListener::bind(("127.0.0.1", local_port)).await {
                    drop(listener);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        abort.abort();
        server_task.abort();
        assert!(manager.tunnels.lock().await.is_empty());
        assert!(closed, "cancelled chain left listener {local_port}");
    }

    struct DirectEchoServer {
        target: Arc<std::sync::Mutex<Option<(String, u32)>>>,
    }

    impl server::Server for DirectEchoServer {
        type Handler = DirectEchoHandler;

        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> DirectEchoHandler {
            DirectEchoHandler { target: self.target.clone() }
        }
    }

    struct DirectEchoHandler {
        target: Arc<std::sync::Mutex<Option<(String, u32)>>>,
    }

    impl server::Handler for DirectEchoHandler {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            _channel: Channel<server::Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            _session: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            *self.target.lock().unwrap() = Some((host_to_connect.to_string(), port_to_connect));
            Ok(true)
        }

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.data(channel, data.to_vec())?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn socks5_proxy_forwards_requested_target_over_ssh() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config { keys: vec![server_key], ..Default::default() };
        let ssh_port = portpicker::pick_unused_port().expect("no free port");
        let target = Arc::new(std::sync::Mutex::new(None));
        let mut server = DirectEchoServer { target: target.clone() };
        let server_task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", ssh_port)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        HostKeyVerifier::new(known_hosts_path).learn("127.0.0.1", ssh_port, &test_server_public_key()).unwrap();
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = manager
            .start_socks5_proxy(
                "rocketmq-socks",
                "127.0.0.1",
                ssh_port,
                "127.0.0.1",
                ssh_port,
                "user",
                "",
                "",
                "",
                false,
                "",
                "",
                "none",
                5,
                false,
                "",
            )
            .await
            .unwrap();
        let reused_port = manager
            .start_socks5_proxy(
                "rocketmq-socks",
                "127.0.0.1",
                ssh_port,
                "127.0.0.1",
                ssh_port,
                "user",
                "",
                "",
                "",
                false,
                "",
                "",
                "none",
                5,
                false,
                "",
            )
            .await
            .unwrap();
        assert_eq!(reused_port, local_port);

        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut greeting = [0_u8; 2];
        client.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [0x05, 0x00]);

        let host = b"broker.internal";
        let mut request = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
        request.extend_from_slice(host);
        request.extend_from_slice(&10911_u16.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut reply = [0_u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0x00);

        client.write_all(b"ping").await.unwrap();
        let mut echoed = [0_u8; 4];
        tokio::time::timeout(std::time::Duration::from_secs(5), client.read_exact(&mut echoed))
            .await
            .expect("SOCKS5 echo timeout")
            .expect("SOCKS5 echo read");
        assert_eq!(&echoed, b"ping");
        assert_eq!(*target.lock().unwrap(), Some(("broker.internal".to_string(), 10911)));

        manager.stop_tunnel("rocketmq-socks").await;
        server_task.abort();
    }

    async fn start_direct_echo_server(
        data_dir: &std::path::Path,
    ) -> (u16, Arc<std::sync::Mutex<Option<(String, u32)>>>, tokio::task::JoinHandle<()>) {
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config { keys: vec![server_key], ..Default::default() };
        let ssh_port = portpicker::pick_unused_port().expect("no free port");
        let target = Arc::new(std::sync::Mutex::new(None));
        let mut server = DirectEchoServer { target: target.clone() };
        let server_task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", ssh_port)).await;
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        HostKeyVerifier::new(data_dir.join("known_hosts"))
            .learn("127.0.0.1", ssh_port, &test_server_public_key())
            .unwrap();
        (ssh_port, target, server_task)
    }

    async fn free_local_port() -> u16 {
        let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        probe.local_addr().unwrap().port()
    }

    async fn start_echo_tunnel(
        manager: &TunnelManager,
        ssh_port: u16,
        requested_local_port: Option<u16>,
    ) -> Result<u16, String> {
        manager
            .start_tunnel_on_local_port(
                "fixed-port",
                "127.0.0.1",
                ssh_port,
                "127.0.0.1",
                ssh_port,
                "user",
                "",
                "",
                "",
                false,
                "",
                "",
                "none",
                5,
                "db.internal",
                5432,
                false,
                false,
                requested_local_port,
                "",
            )
            .await
    }

    async fn assert_echoes_through(local_port: u16) {
        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut echoed = [0_u8; 4];
        tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut echoed))
            .await
            .expect("tunnel echo timeout")
            .expect("tunnel echo read");
        assert_eq!(&echoed, b"ping");
    }

    #[tokio::test]
    async fn requested_local_port_tunnel_listens_on_that_port_and_forwards() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let dir = tempdir().unwrap();
        let (ssh_port, target, server_task) = start_direct_echo_server(dir.path()).await;
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = free_local_port().await;

        let bound = start_echo_tunnel(&manager, ssh_port, Some(local_port)).await.unwrap();

        assert_eq!(bound, local_port);
        assert_echoes_through(local_port).await;
        assert_eq!(*target.lock().unwrap(), Some(("db.internal".to_string(), 5432)));
        assert_eq!(start_echo_tunnel(&manager, ssh_port, None).await.unwrap(), local_port);

        manager.stop_tunnel("fixed-port").await;
        server_task.abort();
    }

    #[tokio::test]
    async fn stopping_a_tunnel_releases_its_requested_local_port_before_returning() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let dir = tempdir().unwrap();
        let (ssh_port, _target, server_task) = start_direct_echo_server(dir.path()).await;
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = free_local_port().await;

        for stop_all in [false, true] {
            let label = if stop_all { "stop_all_tunnels" } else { "stop_tunnel" };
            assert_eq!(start_echo_tunnel(&manager, ssh_port, Some(local_port)).await.unwrap(), local_port, "{label}");
            if stop_all {
                manager.stop_all_tunnels().await;
            } else {
                manager.stop_tunnel("fixed-port").await;
            }

            let rebound = start_echo_tunnel(&manager, ssh_port, Some(local_port))
                .await
                .unwrap_or_else(|error| panic!("rebind after {label} failed: {error}"));

            assert_eq!(rebound, local_port, "{label}");
            assert_echoes_through(local_port).await;
            manager.stop_tunnel("fixed-port").await;
        }
        server_task.abort();
    }

    #[tokio::test]
    async fn transport_layers_bind_the_requested_final_ssh_local_port_across_restarts() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let dir = tempdir().unwrap();
        let (ssh_port, target, server_task) = start_direct_echo_server(dir.path()).await;
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let proxy_tunnels = ProxyTunnelManager::new();
        let http_tunnels = HttpTunnelManager::new();
        let local_port = free_local_port().await;
        let layers = vec![TransportLayerConfig::Ssh(SshTunnelConfig {
            password: String::new(),
            auth_method: "none".to_string(),
            ..hop("ssh-layer", "127.0.0.1", ssh_port)
        })];

        for restart in 0..2 {
            let bound = start_transport_layers_with_final_ssh_local_port(
                "conn",
                &layers,
                "db.internal",
                5432,
                Some(local_port),
                &manager,
                &proxy_tunnels,
                &http_tunnels,
            )
            .await
            .unwrap_or_else(|error| panic!("start {restart} failed: {error}"));

            assert_eq!(bound, local_port, "start {restart}");
            assert_echoes_through(local_port).await;
            stop_transport_layers("conn", layers.len(), &manager, &proxy_tunnels, &http_tunnels).await;
        }
        assert_eq!(*target.lock().unwrap(), Some(("db.internal".to_string(), 5432)));
        server_task.abort();
    }

    struct NetcatFallbackServer {
        command: Arc<std::sync::Mutex<Vec<u8>>>,
    }

    impl server::Server for NetcatFallbackServer {
        type Handler = NetcatFallbackHandler;

        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> NetcatFallbackHandler {
            NetcatFallbackHandler { command: self.command.clone() }
        }
    }

    struct NetcatFallbackHandler {
        command: Arc<std::sync::Mutex<Vec<u8>>>,
    }

    impl server::Handler for NetcatFallbackHandler {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            _channel: Channel<server::Msg>,
            _host_to_connect: &str,
            _port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            _session: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            Ok(false)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<server::Msg>,
            _session: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            *self.command.lock().unwrap() = data.to_vec();
            session.channel_success(channel)?;
            Ok(())
        }

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.data(channel, data.to_vec())?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn tunnel_falls_back_to_netcat_when_direct_tcpip_is_prohibited() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config { keys: vec![server_key], ..Default::default() };
        let port = portpicker::pick_unused_port().expect("no free port");
        let command = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut server = NetcatFallbackServer { command: command.clone() };
        let server_task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", port)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        HostKeyVerifier::new(known_hosts_path.clone()).learn("127.0.0.1", port, &test_server_public_key()).unwrap();
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = manager
            .start_tunnel(
                "netcat-fallback",
                "127.0.0.1",
                port,
                "127.0.0.1",
                port,
                "user",
                "",
                "",
                "",
                false,
                "",
                "",
                "none",
                5,
                "db.internal",
                5432,
                false,
                true,
                "",
            )
            .await
            .expect("start fallback tunnel");

        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut echoed = [0_u8; 4];
        tokio::time::timeout(std::time::Duration::from_secs(5), client.read_exact(&mut echoed))
            .await
            .expect("fallback echo timeout")
            .expect("fallback echo read");
        assert_eq!(&echoed, b"ping");
        assert_eq!(&*command.lock().unwrap(), b"exec nc 'db.internal' 5432");

        manager.stop_tunnel("netcat-fallback").await;
        server_task.abort();
    }

    #[tokio::test]
    async fn prohibited_direct_tcpip_does_not_run_netcat_by_default() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config { keys: vec![server_key], ..Default::default() };
        let port = portpicker::pick_unused_port().expect("no free port");
        let command = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut server = NetcatFallbackServer { command: command.clone() };
        let server_task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", port)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        HostKeyVerifier::new(known_hosts_path.clone()).learn("127.0.0.1", port, &test_server_public_key()).unwrap();
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = manager
            .start_tunnel(
                "netcat-disabled-by-default",
                "127.0.0.1",
                port,
                "127.0.0.1",
                port,
                "user",
                "",
                "",
                "",
                false,
                "",
                "",
                "none",
                5,
                "db.internal",
                5432,
                false,
                false,
                "",
            )
            .await
            .expect("start tunnel");

        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        let _ = client.write_all(b"ping").await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(command.lock().unwrap().is_empty(), "generic SSH server must not receive an nc command by default");

        manager.stop_tunnel("netcat-disabled-by-default").await;
        server_task.abort();
    }

    #[tokio::test]
    async fn forwarded_connection_checks_logical_host_identity() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (connect_port, server_task) = start_accept_none_server().await;
        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        let (gateway_tx, mut gateway_rx) = mpsc::channel::<ssh_prompt::SshPromptEnvelope>(1);
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let envelope = gateway_rx.recv().await.expect("host-key prompt");
            let _ = request_tx.send((envelope.request.host.clone(), envelope.request.port));
            let _ = envelope.responder.send(ssh_prompt::SshPromptAnswer::Accept { remember: true });
        });
        ssh_prompt::install_ssh_prompt_gateway(gateway_tx);

        let session = connect_and_authenticate(
            "127.0.0.1",
            connect_port,
            "ssh-target.invalid",
            2222,
            "user",
            "",
            "",
            "",
            false,
            "",
            "",
            "none",
            5,
            &known_hosts_path,
            "",
        )
        .await
        .expect("forwarded SSH connection should authenticate");

        assert_eq!(request_rx.await.unwrap(), ("ssh-target.invalid".to_string(), 2222));
        let known_hosts = std::fs::read_to_string(&known_hosts_path).unwrap();
        assert!(known_hosts.contains("[ssh-target.invalid]:2222"));
        assert!(!known_hosts.contains("127.0.0.1"));

        drop(session);
        ssh_prompt::clear_ssh_prompt_gateway();
        server_task.abort();
    }

    /// Accepting an unknown host key must not fail with a network-level
    /// connect timeout just because the user took a couple of seconds to
    /// read the fingerprint dialog and click "accept". The interactive
    /// wait must not be charged against `connect_timeout_secs`.
    #[tokio::test]
    async fn slow_host_key_acceptance_does_not_time_out_the_connection() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (connect_port, server_task) = start_accept_none_server().await;
        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        let (gateway_tx, mut gateway_rx) = mpsc::channel::<ssh_prompt::SshPromptEnvelope>(1);
        tokio::spawn(async move {
            let envelope = gateway_rx.recv().await.expect("host-key prompt");
            // Simulate the user taking longer to read/accept the fingerprint
            // dialog than the (deliberately short) network connect timeout.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let _ = envelope.responder.send(ssh_prompt::SshPromptAnswer::Accept { remember: true });
        });
        ssh_prompt::install_ssh_prompt_gateway(gateway_tx);

        let session = connect_and_authenticate(
            "127.0.0.1",
            connect_port,
            "ssh-target.invalid",
            2222,
            "user",
            "",
            "",
            "",
            false,
            "",
            "",
            "none",
            1,
            &known_hosts_path,
            "",
        )
        .await
        .expect("accepting the host key after the network timeout window should still succeed");

        let known_hosts = std::fs::read_to_string(&known_hosts_path).unwrap();
        assert!(known_hosts.contains("[ssh-target.invalid]:2222"), "accepted key should be learned: {known_hosts}");

        drop(session);
        ssh_prompt::clear_ssh_prompt_gateway();
        server_task.abort();
    }

    #[tokio::test]
    async fn concurrent_tunnel_starts_share_one_handshake() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let (connect_port, server_task) = start_accept_none_server().await;
        let dir = tempdir().unwrap();
        let manager = Arc::new(TunnelManager::new(dir.path().to_path_buf()));
        let prompt_count = Arc::new(AtomicUsize::new(0));
        let observed_count = prompt_count.clone();
        let (gateway_tx, mut gateway_rx) = mpsc::channel::<ssh_prompt::SshPromptEnvelope>(8);
        tokio::spawn(async move {
            while let Some(envelope) = gateway_rx.recv().await {
                observed_count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let _ = envelope.responder.send(ssh_prompt::SshPromptAnswer::Accept { remember: false });
            }
        });
        ssh_prompt::install_ssh_prompt_gateway(gateway_tx);

        let first = manager.start_tunnel(
            "shared-layer",
            "127.0.0.1",
            connect_port,
            "ssh-target.invalid",
            2222,
            "user",
            "",
            "",
            "",
            false,
            "",
            "",
            "none",
            5,
            "db.internal",
            5432,
            false,
            false,
            "",
        );
        let second = manager.start_tunnel(
            "shared-layer",
            "127.0.0.1",
            connect_port,
            "ssh-target.invalid",
            2222,
            "user",
            "",
            "",
            "",
            false,
            "",
            "",
            "none",
            5,
            "db.internal",
            5432,
            false,
            false,
            "",
        );
        let (first_port, second_port) = tokio::join!(first, second);

        assert_eq!(first_port.unwrap(), second_port.unwrap());
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);

        manager.stop_tunnel("shared-layer").await;
        ssh_prompt::clear_ssh_prompt_gateway();
        server_task.abort();
    }

    /// Minimal SSH server used to prove the client never sends a password to a
    /// host whose key does not match the known-hosts store. `auth_password`
    /// flips `password_attempted` so the test can assert it was never called.
    struct MitmServer {
        password_attempted: Arc<AtomicBool>,
    }

    impl server::Server for MitmServer {
        type Handler = MitmHandler;
        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> MitmHandler {
            MitmHandler { password_attempted: self.password_attempted.clone() }
        }
    }

    struct MitmHandler {
        password_attempted: Arc<AtomicBool>,
    }

    impl server::Handler for MitmHandler {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
            self.password_attempted.store(true, Ordering::SeqCst);
            Ok(Auth::reject())
        }
    }

    #[tokio::test]
    async fn unknown_host_without_persist_permission_does_not_leak_password() {
        let _guard = prompt_test_lock().lock().await;
        // This test proves the client never sends a password to an untrusted
        // host. It must run with NO prompt gateway installed so the handshake
        // fails closed (no UI to confirm the key -> reject before auth).
        ssh_prompt::clear_ssh_prompt_gateway();
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        let password_attempted = Arc::new(AtomicBool::new(false));

        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        // Advertise password auth so it *would* be attempted if the handshake
        // ever reached the authentication phase.
        let server_config = server::Config { keys: vec![server_key], methods: MethodSet::all(), ..Default::default() };

        let port = portpicker::pick_unused_port().expect("no free port");
        let mut server = MitmServer { password_attempted: password_attempted.clone() };
        let server_task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", port)).await;
        });
        // Let the listener bind before the client connects.
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Point the verifier at a path whose parent is a file, so the unknown
        // host key can NEVER be persisted. dbx must fail-closed: abort the
        // handshake and never send a password to an untrusted endpoint (the
        // old store silently trusted it in memory — this must not happen).
        let dir = tempdir().unwrap();
        let frozen = dir.path().join("frozen");
        std::fs::write(&frozen, b"not a directory").unwrap();
        let verifier = HostKeyVerifier::new(frozen.join("known_hosts"));
        let handler = SshClient {
            host_key_verifier: Arc::new(verifier),
            host: "127.0.0.1".to_string(),
            port,
            prompt_started_tx: None,
        };
        let client_config = Arc::new(ssh_client_config());

        let connect_result =
            tokio::time::timeout(Duration::from_secs(10), client::connect(client_config, ("127.0.0.1", port), handler))
                .await;

        // The handshake must abort at the host-key check, so the server must
        // never have been asked for a password.
        assert!(
            !password_attempted.load(Ordering::SeqCst),
            "password auth must NOT be attempted for an untrusted host when the key cannot be persisted"
        );
        // And the connection itself must not succeed.
        assert!(
            connect_result.is_err() || connect_result.unwrap().is_err(),
            "connection should fail when the host key cannot be verified/persisted"
        );

        server_task.abort();
    }

    // --- Reconnect-path authentication failure ---------------------------------

    /// SSH server that accepts the client key exactly once and refuses every
    /// later authentication, and that drops the session as soon as the tunnel
    /// forwards its first connection. This models the real-world sequence
    /// behind the bug: the tunnel comes up, the SSH session later dies, and the
    /// background reconnect is then refused by the server (key revoked or
    /// rotated, `authorized_keys` changed, server policy tightened).
    struct KeyOnceThenRejectServer {
        publickey_attempts: Arc<AtomicUsize>,
    }

    impl server::Server for KeyOnceThenRejectServer {
        type Handler = KeyOnceThenRejectHandler;

        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> KeyOnceThenRejectHandler {
            KeyOnceThenRejectHandler { publickey_attempts: self.publickey_attempts.clone() }
        }
    }

    struct KeyOnceThenRejectHandler {
        publickey_attempts: Arc<AtomicUsize>,
    }

    impl server::Handler for KeyOnceThenRejectHandler {
        type Error = russh::Error;

        async fn auth_publickey(
            &mut self,
            _user: &str,
            _public_key: &russh::keys::ssh_key::PublicKey,
        ) -> Result<Auth, Self::Error> {
            if self.publickey_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::Reject {
                    proceed_with_methods: Some(MethodSet::from(&[MethodKind::PublicKey][..])),
                    partial_success: false,
                })
            }
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            _channel: Channel<server::Msg>,
            _host_to_connect: &str,
            _port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            session: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            // Simulate the SSH session dying while the tunnel is in use.
            let _ = session.disconnect(russh::Disconnect::ByApplication, "simulated session drop", "");
            Ok(false)
        }
    }

    async fn start_key_once_then_reject_server(
        publickey_attempts: Arc<AtomicUsize>,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        let server_key = decode_secret_key(TEST_SERVER_KEY_PEM, None).expect("decode test server key");
        let server_config = server::Config {
            keys: vec![server_key],
            methods: MethodSet::from(&[MethodKind::PublicKey][..]),
            auth_rejection_time: std::time::Duration::ZERO,
            auth_rejection_time_initial: Some(std::time::Duration::ZERO),
            ..Default::default()
        };
        let port = portpicker::pick_unused_port().expect("no free port");
        let mut server = KeyOnceThenRejectServer { publickey_attempts };
        let task = tokio::spawn(async move {
            let _ = server.run_on_address(Arc::new(server_config), ("127.0.0.1", port)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        (port, task)
    }

    #[tokio::test]
    async fn reconnect_auth_failure_is_reported_instead_of_a_dead_local_port() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        let publickey_attempts = Arc::new(AtomicUsize::new(0));
        let (ssh_port, server_task) = start_key_once_then_reject_server(publickey_attempts.clone()).await;

        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        HostKeyVerifier::new(known_hosts_path).learn("127.0.0.1", ssh_port, &test_server_public_key()).unwrap();
        let key_path = dir.path().join("id_ed25519");
        std::fs::write(&key_path, TEST_SERVER_KEY_PEM).unwrap();
        let key_path = key_path.to_str().unwrap().to_string();

        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = manager
            .start_tunnel(
                "reconnect-auth",
                "127.0.0.1",
                ssh_port,
                "127.0.0.1",
                ssh_port,
                "user",
                "",
                &key_path,
                "",
                false,
                "",
                "",
                "key",
                5,
                "db.internal",
                3306,
                false,
                false,
                "",
            )
            .await
            .expect("initial tunnel start should succeed");

        // The first client through the tunnel makes the server drop the SSH
        // session. dbx closes the accepted socket without sending anything,
        // which is exactly what a database driver surfaces as a bare
        // "connection closed" with no hint of the real cause.
        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        let mut buf = [0_u8; 1];
        let first_read = tokio::time::timeout(std::time::Duration::from_secs(5), client.read(&mut buf)).await;
        assert!(
            matches!(first_read, Ok(Ok(0))),
            "the dead tunnel should close the client socket with no data (this is the generic \
             error the user used to see): {first_read:?}"
        );

        // The background reconnect loop now re-authenticates and is refused.
        tokio::time::sleep(std::time::Duration::from_secs(9)).await;
        let attempts = publickey_attempts.load(Ordering::SeqCst);
        assert!(attempts >= 2, "the reconnect loop should have re-attempted publickey auth, got {attempts}");

        // The user retries the connection. This is the call whose result the
        // UI turns into the message shown to the user. It must now carry the
        // SSH authentication rejection rather than a port with no session.
        let retry = manager
            .start_tunnel(
                "reconnect-auth",
                "127.0.0.1",
                ssh_port,
                "127.0.0.1",
                ssh_port,
                "user",
                "",
                &key_path,
                "",
                false,
                "",
                "",
                "key",
                5,
                "db.internal",
                3306,
                false,
                false,
                "",
            )
            .await;

        let error = retry.expect_err("a tunnel whose reconnect was refused must not report success");
        println!("REPRO start_tunnel after the failed reconnect = Err({error})");
        assert!(error.contains("could not reconnect"), "the error should say the tunnel could not reconnect: {error}");
        assert!(
            error.contains("public key authentication failed"),
            "the error should name the real cause (key rejected), not a generic I/O failure: {error}"
        );

        manager.stop_tunnel("reconnect-auth").await;
        server_task.abort();
    }

    #[tokio::test]
    async fn restarting_a_failed_tunnel_on_the_same_local_port_reports_the_ssh_error_not_a_bind_conflict() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        let publickey_attempts = Arc::new(AtomicUsize::new(0));
        let (ssh_port, server_task) = start_key_once_then_reject_server(publickey_attempts).await;
        let dir = tempdir().unwrap();
        HostKeyVerifier::new(dir.path().join("known_hosts"))
            .learn("127.0.0.1", ssh_port, &test_server_public_key())
            .unwrap();
        let key_path = dir.path().join("id_ed25519");
        std::fs::write(&key_path, TEST_SERVER_KEY_PEM).unwrap();
        let key_path = key_path.to_str().unwrap().to_string();
        let manager = TunnelManager::new(dir.path().to_path_buf());
        let local_port = free_local_port().await;
        let start = || {
            manager.start_tunnel_on_local_port(
                "fixed-reconnect",
                "127.0.0.1",
                ssh_port,
                "127.0.0.1",
                ssh_port,
                "user",
                "",
                &key_path,
                "",
                false,
                "",
                "",
                "key",
                5,
                "db.internal",
                3306,
                false,
                false,
                Some(local_port),
                "",
            )
        };
        assert_eq!(start().await.unwrap(), local_port);

        // The first client makes the server drop the session; the reconnect is then refused.
        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        let mut buf = [0_u8; 1];
        let _ = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf)).await;
        let failed = async {
            loop {
                let failure = manager.tunnels.lock().await.get("fixed-reconnect").and_then(|e| e.statuses[0].failure());
                if failure.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(30), failed).await.expect("the reconnect should have been refused");

        let evicted = start().await.unwrap_err();
        assert!(evicted.contains("could not reconnect"), "{evicted}");
        let restarted = start().await.unwrap_err();
        assert!(!restarted.contains("Failed to bind requested local port"), "{restarted}");

        manager.stop_tunnel("fixed-reconnect").await;
        server_task.abort();
    }

    #[tokio::test]
    async fn rejected_public_key_reports_what_the_server_refused() {
        let _guard = prompt_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        // Every publickey attempt is refused, so this exercises the initial
        // handshake rather than the reconnect path.
        let publickey_attempts = Arc::new(AtomicUsize::new(1));
        let (ssh_port, server_task) = start_key_once_then_reject_server(publickey_attempts).await;

        let dir = tempdir().unwrap();
        let known_hosts_path = dir.path().join("known_hosts");
        HostKeyVerifier::new(known_hosts_path.clone()).learn("127.0.0.1", ssh_port, &test_server_public_key()).unwrap();
        let key_path = dir.path().join("id_ed25519");
        std::fs::write(&key_path, TEST_SERVER_KEY_PEM).unwrap();

        // `Handle<SshClient>` is not Debug, so unwrap the error by hand.
        let error = match connect_and_authenticate(
            "127.0.0.1",
            ssh_port,
            "127.0.0.1",
            ssh_port,
            "user",
            "",
            key_path.to_str().unwrap(),
            "",
            false,
            "",
            "",
            "key",
            5,
            &known_hosts_path,
            "",
        )
        .await
        {
            Ok(_) => panic!("a refused key must not authenticate"),
            Err(error) => error,
        };

        println!("REPRO initial key rejection = {error}");
        assert!(error.contains("the server rejected the key"), "{error}");
        // The structured detail russh returned must survive, like the
        // key+password branch already did.
        assert!(error.contains("remaining_methods="), "{error}");

        server_task.abort();
    }

    // --- partial_success MFA reporting ------------------------------------------
    //
    // These test `describe_terminal_auth_failure` directly rather than through
    // a live handshake against this crate's bundled `russh::server` test
    // helper: that implementation unconditionally overwrites
    // `auth_request.partial_success = false` immediately after reading the
    // handler's `Auth::Reject { partial_success, .. }` (see
    // `server_read_auth_request_pk` and the password/none branches in
    // `russh::server::encrypted`), so it can never actually put a `true` on
    // the wire — a limitation of that library's bundled server, not of the
    // client-side code under test here. Real SSH servers (the only thing
    // `connect_and_authenticate` talks to in production) encode this bit
    // correctly, and the client-side decode path (`russh::client::encrypted`)
    // is untouched by that bug.

    #[test]
    fn partial_success_reports_the_factor_as_accepted_not_rejected() {
        let remaining_methods = MethodSet::from(&[MethodKind::PublicKey][..]);

        let message = describe_terminal_auth_failure(
            "public key authentication",
            "the server rejected the key",
            &remaining_methods,
            true,
        );

        assert!(message.contains("succeeded"), "the factor WAS accepted, the message must say so: {message}");
        assert!(!message.contains("rejected"), "must not say the factor was rejected when it was accepted: {message}");
        assert!(message.contains("remaining_methods="), "the structured detail must survive: {message}");
    }

    #[test]
    fn no_partial_success_reports_the_factor_as_rejected() {
        let remaining_methods = MethodSet::from(&[MethodKind::Password][..]);

        let message = describe_terminal_auth_failure(
            "password authentication",
            "the server rejected the password",
            &remaining_methods,
            false,
        );

        assert!(message.contains("the server rejected the password"), "{message}");
        assert!(!message.contains("succeeded"), "a real rejection must not read as accepted: {message}");
        assert!(message.contains("remaining_methods="), "the structured detail must survive: {message}");
    }
}
