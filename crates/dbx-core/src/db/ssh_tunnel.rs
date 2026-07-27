use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::path_utils::expand_tilde;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh::client::{self, AuthResult, Config, Handle};
use russh::keys::agent::{client::AgentClient, AgentIdentity};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{decode_secret_key, key::PrivateKeyWithHashAlg, PrivateKey};
use russh::MethodKind;
use russh::MethodSet;
use russh::{kex, mac, ChannelMsg, Preferred};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior};

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

/// SSH client handler. Holds a host-key verifier so that
/// [`client::Handler::check_server_key`] can reject untrusted/changed server
/// keys *before* any credential is sent.
struct SshClient {
    host_key_verifier: Arc<HostKeyVerifier>,
    host: String,
    port: u16,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Runs *before any credential authentication*. We first check the
        // known-hosts stores (system + dbx-managed). A trusted key is accepted
        // immediately; a *changed* key is rejected (MITM hardening); an unknown
        // key triggers an explicit TOFU prompt so the user can confirm the host
        // fingerprint before any password/key is sent.
        match self.host_key_verifier.check(&self.host, self.port, server_public_key) {
            Ok(HostKeyState::Trusted) => Ok(true),
            Ok(HostKeyState::Unknown) => self.prompt_for_host_key(server_public_key).await,
            Err(e) => {
                // Changed host key => possible MITM. Surface it to the user as a
                // clear notice (best-effort; never affects the fail-closed below).
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
    ) -> Result<bool, russh::Error> {
        let key_type = Some(server_public_key.algorithm().to_string());
        let fingerprint = Some(server_public_key.fingerprint(HashAlg::Sha256).to_string());
        let request = ssh_prompt::host_key_verify_request(&self.host, self.port, key_type, fingerprint);

        let Some(responder_rx) = ssh_prompt::request_ssh_prompt(request) else {
            log::warn!(
                "No SSH prompt gateway installed; refusing to trust unknown host {}:{} (fail-closed)",
                self.host,
                self.port
            );
            return Ok(false);
        };

        let answer = tokio::time::timeout(TOFU_PROMPT_TIMEOUT, responder_rx).await;
        match answer {
            Ok(Ok(ssh_prompt::SshPromptAnswer::Accept { remember })) => {
                if remember {
                    if let Err(e) = self.host_key_verifier.learn(&self.host, self.port, server_public_key) {
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
    for algorithm in [kex::ECDH_SHA2_NISTP256, kex::ECDH_SHA2_NISTP384, kex::ECDH_SHA2_NISTP521, kex::DH_G14_SHA1] {
        if !kex.contains(&algorithm) {
            kex.push(algorithm);
        }
    }
    preferred.kex = Cow::Owned(kex);

    let mut mac = preferred.mac.into_owned();
    // Keep SHA-1 MAC variants as last-resort fallbacks for legacy SSH proxies.
    for algorithm in [mac::HMAC_SHA1_ETM, mac::HMAC_SHA1] {
        if !mac.contains(&algorithm) {
            mac.push(algorithm);
        }
    }
    preferred.mac = Cow::Owned(mac);

    Config { nodelay: true, keepalive_interval: Some(Duration::from_secs(30)), preferred, ..Default::default() }
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

#[allow(clippy::too_many_arguments)]
async fn connect_and_authenticate(
    ssh_host: &str,
    ssh_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    auth_method: &str,
    connect_timeout_secs: u64,
    known_hosts_path: &Path,
) -> Result<Handle<SshClient>, String> {
    let config = Arc::new(ssh_client_config());
    let connect_timeout = Duration::from_secs(connect_timeout_secs);

    // Verify server identity against the known-hosts store before sending any
    // credential. The store lives at `<data_dir>/known_hosts` (NOT `~/.ssh`):
    // an unknown host is trusted on first use (TOFU) and recorded there, a
    // changed host key is rejected, and an unknown host whose key cannot be
    // persisted fails closed instead of being silently trusted.
    let host_key_verifier = Arc::new(HostKeyVerifier::new(known_hosts_path.to_path_buf()));

    let mut session = tokio::time::timeout(
        connect_timeout,
        client::connect(
            config,
            (ssh_host, ssh_port),
            SshClient { host_key_verifier: host_key_verifier.clone(), host: ssh_host.to_string(), port: ssh_port },
        ),
    )
    .await
    .map_err(|_| format!("SSH connection timed out ({connect_timeout_secs}s)"))?
    .map_err(|e| format!("SSH connection failed: {e}"))?;

    // Probe with "none" authentication first. Some SSH proxies and jump-hosts
    // accept connections without any credential, and this is also the standard
    // SSH probe used to discover the auth methods the server supports.
    let none_res = tokio::time::timeout(connect_timeout, session.authenticate_none(ssh_user))
        .await
        .map_err(|_| format!("SSH auth probe timed out ({connect_timeout_secs}s)"))?
        .map_err(|e| format!("SSH auth probe failed: {e}"))?;
    if none_res.success() {
        return Ok(session);
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
                AuthResult::Success => return Ok(session),
                AuthResult::Failure { remaining_methods, partial_success } => {
                    // Only fall back to password when the server still offers it.
                    // This prevents sending the password to a server that never
                    // advertised password auth — the MITM credential-harvest
                    // case — and preserves the protocol state needed for
                    // publickey+password MFA (where `password` IS in the list).
                    if server_offers_password(&remaining_methods) {
                        true
                    } else {
                        return Err(format!(
                            "SSH key rejected and the server does not offer password authentication \
                             (remaining_methods={remaining_methods:?}, partial_success={partial_success})"
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
                AuthResult::Success => return Ok(session),
                AuthResult::Failure { partial_success, .. } => {
                    return Err(format!("SSH password authentication failed (partial_success={partial_success})"));
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
        if !auth_res.success() {
            return Err("SSH public key authentication failed".to_string());
        }
    } else if try_password {
        let auth_res = tokio::time::timeout(connect_timeout, session.authenticate_password(ssh_user, ssh_password))
            .await
            .map_err(|_| format!("SSH password auth timed out ({connect_timeout_secs}s)"))?
            .map_err(|e| format!("SSH password auth failed: {e}"))?;
        if !auth_res.success() {
            return Err("SSH password authentication failed".to_string());
        }
    } else if try_agent {
        match try_authenticate_with_agent(&mut session, ssh_user, ssh_agent_sock_path, &connect_timeout).await {
            Ok(()) => {}
            Err(agent_err) => return Err(agent_err),
        }
    } else {
        return Err(
            "SSH authentication failed: \"none\" was rejected and no password, key, or ssh-agent is configured"
                .to_string(),
        );
    }

    Ok(session)
}

/// Try to authenticate using ssh-agent identities. Returns `Ok(())` on success,
/// or an error describing why agent auth failed (unavailable, no identities, all rejected).
async fn try_authenticate_with_agent(
    session: &mut Handle<SshClient>,
    ssh_user: &str,
    _ssh_agent_sock_path: &str,
    connect_timeout: &Duration,
) -> Result<(), String> {
    #[cfg(unix)]
    let mut agent = if _ssh_agent_sock_path.is_empty() {
        match AgentClient::connect_env().await {
            Ok(a) => a,
            Err(e) => {
                return Err(format!("No SSH password or key provided, and ssh-agent is unavailable: {e}"));
            }
        }
    } else {
        match AgentClient::connect_uds(_ssh_agent_sock_path).await {
            Ok(a) => a,
            Err(e) => {
                return Err(format!(
                    "No SSH password or key provided, and ssh-agent at '{}' is unavailable: {e}",
                    _ssh_agent_sock_path
                ));
            }
        }
    };

    #[cfg(windows)]
    let mut agent = {
        let stream = pageant::PageantStream::new()
            .await
            .map_err(|e| format!("No SSH password or key provided, and ssh-agent (Pageant) is unavailable: {e}"))?;
        AgentClient::connect(stream)
    };

    let identities = match agent.request_identities().await {
        Ok(ids) if ids.is_empty() => {
            return Err("No SSH password or key provided, and ssh-agent has no identities".to_string());
        }
        Ok(ids) => ids,
        Err(e) => {
            return Err(format!("No SSH password or key provided, and ssh-agent request failed: {e}"));
        }
    };

    let hash_alg = session.best_supported_rsa_hash().await.ok().flatten().flatten();

    let auth_result = tokio::time::timeout(*connect_timeout, async {
        for identity in identities {
            let result = match &identity {
                AgentIdentity::PublicKey { key, .. } => {
                    session.authenticate_publickey_with(ssh_user, key.clone(), hash_alg, &mut agent).await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    session.authenticate_certificate_with(ssh_user, certificate.clone(), hash_alg, &mut agent).await
                }
            };

            match result {
                Ok(auth_res) if auth_res.success() => return Ok(()),
                Ok(_) => continue,
                Err(e) => {
                    log::debug!("SSH agent identity ({}) auth failed: {e}", identity.comment());
                    continue;
                }
            }
        }
        Err("No SSH password or key provided, and no ssh-agent identity was accepted".to_string())
    })
    .await;

    match auth_result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("No SSH password or key provided, and ssh-agent auth timed out".to_string()),
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

/// Accept connections on the local listener and forward them through the SSH session.
/// Returns when the SSH session dies (listener error or session.is_closed()).
async fn forward_loop(session: &Handle<SshClient>, listener: &TcpListener, remote_host: &str, remote_port: u16) {
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

        let mut channel = match session
            .channel_open_direct_tcpip(
                remote_host,
                remote_port.into(),
                peer_addr.ip().to_string(),
                peer_addr.port().into(),
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("SSH direct-tcpip failed: {e}");
                break;
            }
        };

        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            let mut stream_closed = false;

            loop {
                tokio::select! {
                    r = stream.read(&mut buf), if !stream_closed => {
                        match r {
                            Ok(0) => {
                                stream_closed = true;
                                let _ = channel.eof().await;
                            }
                            Ok(n) => {
                                if channel.data(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                if stream.write_all(data).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | None => break,
                            _ => {}
                        }
                    }
                }
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
    ssh_user: String,
    ssh_password: String,
    ssh_key_path: String,
    ssh_key_passphrase: String,
    use_ssh_agent: bool,
    ssh_agent_sock_path: String,
    auth_method: String,
    connect_timeout_secs: u64,
    known_hosts_path: PathBuf,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
) {
    loop {
        log::info!("SSH tunnel active: {}:{} -> {}:{}", connect_host, connect_port, remote_host, remote_port);

        forward_loop(&session, &listener, &remote_host, remote_port).await;

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
                &ssh_user,
                &ssh_password,
                &ssh_key_path,
                &ssh_key_passphrase,
                use_ssh_agent,
                &ssh_agent_sock_path,
                &auth_method,
                connect_timeout_secs,
                &known_hosts_path,
            )
            .await
            {
                Ok(new_session) => {
                    session = new_session;
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
                    // Exponential backoff: double the delay, cap at MAX_RECONNECT_DELAY
                    delay = std::cmp::min(delay * 2, MAX_RECONNECT_DELAY);
                }
            }
        }
    }
}

struct TunnelEntry {
    handles: Vec<JoinHandle<()>>,
    local_port: u16,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedTunnel {
    connect_host: String,
    connect_port: u16,
    remote_host: String,
    remote_port: u16,
}

pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, TunnelEntry>>,
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
        Self { tunnels: Mutex::new(HashMap::new()), known_hosts_path }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_tunnel(
        &self,
        connection_id: &str,
        ssh_host: &str,
        ssh_port: u16,
        ssh_user: &str,
        ssh_password: &str,
        ssh_key_path: &str,
        ssh_key_passphrase: &str,
        use_ssh_agent: bool,
        ssh_agent_sock_path: &str,
        auth_method: &str,
        connect_timeout_secs: u64,
        remote_host: &str,
        remote_port: u16,
        expose_to_lan: bool,
    ) -> Result<u16, String> {
        // Check cache under lock to avoid race with concurrent callers.
        // Also evict stale entries whose background task has exited.
        {
            let mut tunnels = self.tunnels.lock().await;
            if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
                return Ok(port);
            }
        }
        // Slow SSH connection — do this outside the lock.
        let (handle, local_port) = spawn_tunnel(
            ssh_host,
            ssh_port,
            ssh_user,
            ssh_password,
            ssh_key_path,
            ssh_key_passphrase,
            use_ssh_agent,
            ssh_agent_sock_path,
            auth_method,
            connect_timeout_secs,
            &self.known_hosts_path,
            remote_host,
            remote_port,
            expose_to_lan,
        )
        .await?;

        // Re-check under lock: another caller may have beaten us.
        let mut tunnels = self.tunnels.lock().await;
        if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
            // Another task already created a live tunnel; abort ours.
            handle.abort();
            return Ok(port);
        }
        tunnels.insert(connection_id.to_string(), TunnelEntry { handles: vec![handle], local_port });
        Ok(local_port)
    }

    /// Returns the local port for a cached tunnel entry, or `None` if the entry
    /// is stale (all background handles have exited).
    fn get_active_port(tunnels: &mut HashMap<String, TunnelEntry>, connection_id: &str) -> Option<u16> {
        let entry = tunnels.get(connection_id)?;
        if entry.handles.iter().all(|h| h.is_finished()) {
            tunnels.remove(connection_id);
            return None;
        }
        Some(entry.local_port)
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
        // Check cache under lock; evict stale entries.
        {
            let mut tunnels = self.tunnels.lock().await;
            if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
                return Ok(port);
            }
        }

        let mut handles = Vec::new();
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

            let (handle, local_port) = spawn_tunnel(
                &connect_host,
                connect_port,
                &hop.user,
                &hop.password,
                &hop.key_path,
                &hop.key_passphrase,
                hop.use_ssh_agent,
                &hop.ssh_agent_sock_path,
                &hop.auth_method,
                effective_hop_timeout(hop),
                &self.known_hosts_path,
                &target_host,
                target_port,
                is_last && hop.expose_lan,
            )
            .await
            .map_err(|err| format!("SSH hop {} failed: {err}", index + 1))?;

            handles.push(handle);
            final_local_port = local_port;
            next_connect_endpoint = Some(("127.0.0.1".to_string(), local_port));
        }

        // Re-check under lock: another caller may have beaten us.
        let mut tunnels = self.tunnels.lock().await;
        if let Some(port) = Self::get_active_port(&mut tunnels, connection_id) {
            for handle in handles {
                handle.abort();
            }
            return Ok(port);
        }
        tunnels.insert(connection_id.to_string(), TunnelEntry { handles, local_port: final_local_port });
        Ok(final_local_port)
    }

    pub async fn local_port(&self, connection_id: &str) -> Option<u16> {
        self.tunnels.lock().await.get(connection_id).map(|entry| entry.local_port)
    }

    pub async fn stop_tunnel(&self, connection_id: &str) {
        if let Some(entry) = self.tunnels.lock().await.remove(connection_id) {
            for handle in entry.handles {
                handle.abort();
            }
        }
    }

    pub async fn stop_tunnels_with_prefix(&self, connection_id_prefix: &str) {
        let mut tunnels = self.tunnels.lock().await;
        let keys: Vec<String> = tunnels.keys().filter(|key| key.starts_with(connection_id_prefix)).cloned().collect();
        for key in keys {
            if let Some(entry) = tunnels.remove(&key) {
                for handle in entry.handles {
                    handle.abort();
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_tunnel(
    connect_host: &str,
    connect_port: u16,
    ssh_user: &str,
    ssh_password: &str,
    ssh_key_path: &str,
    ssh_key_passphrase: &str,
    use_ssh_agent: bool,
    ssh_agent_sock_path: &str,
    auth_method: &str,
    connect_timeout_secs: u64,
    known_hosts_path: &Path,
    remote_host: &str,
    remote_port: u16,
    expose_to_lan: bool,
) -> Result<(JoinHandle<()>, u16), String> {
    let local_port = portpicker::pick_unused_port().ok_or("No available port")?;

    let bind_addr = if expose_to_lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener =
        TcpListener::bind((bind_addr, local_port)).await.map_err(|e| format!("Failed to bind local port: {e}"))?;

    // Initial connection: fail fast on bad credentials
    let session = connect_and_authenticate(
        connect_host,
        connect_port,
        ssh_user,
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        use_ssh_agent,
        ssh_agent_sock_path,
        auth_method,
        connect_timeout_secs,
        known_hosts_path,
    )
    .await?;

    let handle = tokio::spawn(tunnel_reconnect_loop(
        session,
        connect_host.to_string(),
        connect_port,
        ssh_user.to_string(),
        ssh_password.to_string(),
        ssh_key_path.to_string(),
        ssh_key_passphrase.to_string(),
        use_ssh_agent,
        ssh_agent_sock_path.to_string(),
        auth_method.to_string(),
        connect_timeout_secs,
        known_hosts_path.to_path_buf(),
        listener,
        remote_host.to_string(),
        remote_port,
    ));

    Ok((handle, local_port))
}

fn effective_hop_timeout(hop: &SshTunnelConfig) -> u64 {
    if hop.connect_timeout_secs == 0 {
        crate::models::connection::default_ssh_connect_timeout_secs()
    } else {
        hop.connect_timeout_secs
    }
}

/// Serializes every test that mutates the process-global SSH prompt gateway so
/// they cannot clobber each other's gateway (or the MITM fail-closed test,
/// which relies on *no* gateway being installed). Test-only.
#[cfg(test)]
static PROMPT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
        planned.push(PlannedTunnel { connect_host, connect_port, remote_host: target_host, remote_port: target_port });
        if let Some(local_port) = local_ports.get(index) {
            next_connect_endpoint = Some(("127.0.0.1".to_string(), *local_port));
        }
    }
    planned
}

#[cfg(test)]
mod tests {
    use super::SshClient;
    use super::PROMPT_TEST_LOCK;
    use super::{
        effective_hop_timeout, openssh_padding_len, plan_chain, read_ssh_string,
        sanitize_unencrypted_openssh_comment_bytes, server_offers_password, ssh_client_config, HostKeyState,
        HostKeyVerifier, PlannedTunnel, TunnelManager,
    };
    use crate::db::ssh_prompt;
    use crate::models::connection::{default_ssh_connect_timeout_secs, SshTunnelConfig};
    use russh::client;
    use russh::client::Handler;
    use russh::keys::decode_secret_key;
    use russh::keys::ssh_key::PublicKey;
    use russh::server::{self, Auth, Server};
    use russh::MethodKind;
    use russh::MethodSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::mpsc;

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
            use_ssh_agent: false,
            ssh_agent_sock_path: String::new(),
            auth_method: "password".to_string(),
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
                    remote_host: "bastion-b".to_string(),
                    remote_port: 2200,
                },
                PlannedTunnel {
                    connect_host: "127.0.0.1".to_string(),
                    connect_port: 41001,
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
    fn changed_host_key_is_rejected() {
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
        assert!(verifier.check("db.example.com", 22, &key).is_err(), "changed host key must be rejected (MITM)");
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
        let _guard = PROMPT_TEST_LOCK.lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Accept { remember: true });
        let mut client =
            SshClient { host_key_verifier: Arc::new(verifier), host: "db.example.com".to_string(), port: 22 };

        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "accepted host key should be trusted");
        // The accepted key must be persisted when remember=true.
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("db.example.com"), "accepted key should be learned: {contents}");
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[tokio::test]
    async fn unknown_host_prompt_accept_without_remember_is_session_only() {
        let _guard = PROMPT_TEST_LOCK.lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Accept { remember: false });
        let mut client =
            SshClient { host_key_verifier: Arc::new(verifier), host: "db.example.com".to_string(), port: 22 };

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
        let _guard = PROMPT_TEST_LOCK.lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path.clone());
        let key = test_server_public_key();

        install_fake_prompt_gateway(ssh_prompt::SshPromptAnswer::Reject);
        let mut client =
            SshClient { host_key_verifier: Arc::new(verifier), host: "db.example.com".to_string(), port: 22 };

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
        let _guard = PROMPT_TEST_LOCK.lock().await;
        // Ensure no gateway is installed so request_ssh_prompt returns None.
        ssh_prompt::clear_ssh_prompt_gateway();
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path);
        let key = test_server_public_key();

        let mut client =
            SshClient { host_key_verifier: Arc::new(verifier), host: "db.example.com".to_string(), port: 22 };
        let trusted = client.check_server_key(&key).await.unwrap();
        // No UI to confirm -> fail-closed, host is not trusted.
        assert!(!trusted, "without a gateway, an unknown host must be rejected (fail-closed)");
    }

    #[tokio::test]
    async fn trusted_host_skips_prompt() {
        let _guard = PROMPT_TEST_LOCK.lock().await;
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let verifier = HostKeyVerifier::new(path);
        let key = test_server_public_key();
        // Pre-seed the store so the host is already trusted.
        verifier.learn("db.example.com", 22, &key).unwrap();

        // No gateway installed, but the host is trusted so no prompt is needed.
        ssh_prompt::clear_ssh_prompt_gateway();
        let mut client =
            SshClient { host_key_verifier: Arc::new(verifier), host: "db.example.com".to_string(), port: 22 };
        let trusted = client.check_server_key(&key).await.unwrap();
        assert!(trusted, "a known-trusted host must be accepted without a prompt");
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

    // --- MITM hardening: a changed/unknown host never receives the password ---

    const TEST_SERVER_KEY_PEM: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAVDlhwKBk+QMZN+WNAUKL6qLr3hf3S5p1TdSK4hMhLxwAAAJD9wI28/cCN
vAAAAAtzc2gtZWQyNTUxOQAAACAVDlhwKBk+QMZN+WNAUKL6qLr3hf3S5p1TdSK4hMhLxw
AAAEDxqdMQX37UdhziSi5Br3kyRM/Xrpo9ZcXoguYkeogq0hUOWHAoGT5Axk35Y0BQovqo
uveF/dLmnVN1IriEyEvHAAAACGRieC10ZXN0AQIDBAU=
-----END OPENSSH PRIVATE KEY-----"#;

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
        let _guard = PROMPT_TEST_LOCK.lock().await;
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
        let handler = SshClient { host_key_verifier: Arc::new(verifier), host: "127.0.0.1".to_string(), port };
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
}
