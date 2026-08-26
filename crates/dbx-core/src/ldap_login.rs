//! Web / desktop login via LDAP simple bind.
//!
//! This module is independent of the per-connection LDAP pool and is consumed
//! by `dbx-web`'s auth handler. The login configuration lives in the
//! application settings (`LdapLoginSettings`, stored by `dbx-core::Storage`)
//! and is editable from the app settings page — the legacy `LDAP_SUPPORT`
//! environment-variable approach was removed in favour of this UI-managed
//! configuration, so that adding further login providers (e.g. OIDC) later
//! stays a pure settings-page exercise.
//!
//! It supports two operational modes:
//!
//! - `NOSV` ("no service account"): the supplied username is used directly
//!   to build a bind DN — useful for AD where `sAMAccountName`, an email, a
//!   fully-qualified `CN=…` or `DOMAIN\user` is acceptable. The server performs
//!   the bind and reports success or failure directly.
//!
//! - `SV` ("service account"): a privileged bind DN is used to look up the
//!   user's DN first (by `sAMAccountName` / `uid` / `mail`), then the server
//!   rebinds with the resolved DN and the supplied password.
//!
//! # Bind identity resolution
//!
//! A simple bind takes a *distinguished name*. Active Directory additionally
//! tolerates the down-level logon name (`CORP\alice`) and the UPN
//! (`alice@corp.example.com`), but RFC-strict servers (OpenLDAP, 389-DS, …)
//! parse the value as a DN and answer `invalidDNSyntax` (rc=34) for anything
//! else — `CORP\alice` has no `=` and `\a` is not a valid RFC 4514 escape.
//!
//! For the service-account (`SV`) flow we derive an *ordered* list of bind
//! identities for the configured service account and [`bind_first_candidate`]
//! tries them on one connection, moving on only when the server rejected the
//! *shape* of the identity (`invalidDNSyntax` / `noSuchObject` / AD's
//! `data 525`). Any answer that implies the account was actually found —
//! wrong password, locked, expired — stops the loop immediately so we never
//! inflate `badPwdCount`. If every candidate was refused as "not a DN" we fall
//! back to resolving the real DN with a directory search.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ldap3::{Ldap, LdapConnAsync, LdapError, Scope};
use serde::{Deserialize, Serialize};

/// High level login mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LdapSupportMode {
    /// LDAP login is enabled with a service account configured by the
    /// operator.
    Sv,
    /// LDAP login is enabled without a service account. The supplied username
    /// is used directly for the bind.
    NoSv,
}

// ---------------------------------------------------------------------------
// DN / filter syntax helpers
// ---------------------------------------------------------------------------

/// `noSuchObject` — the bind DN parsed fine but does not exist.
const RC_NO_SUCH_OBJECT: u32 = 32;
/// `invalidDNSyntax` — the server could not parse the value as a DN at all.
const RC_INVALID_DN_SYNTAX: u32 = 34;
/// `invalidCredentials` — may or may not mean "wrong password", see
/// [`ad_data_code`].
const RC_INVALID_CREDENTIALS: u32 = 49;

/// Active Directory reports "this account does not exist" as
/// `invalidCredentials` with `data 525` in the diagnostic text. Every other
/// `data` code (`52e` wrong password, `775` locked out, `533` disabled, …)
/// means the account *was* found, so probing further identities would only
/// inflate `badPwdCount` and risk a lockout.
const AD_DATA_USER_NOT_FOUND: &str = "525";

/// Default filter used to resolve a user's DN by search when the server
/// refuses every non-DN bind identity. Covers the usual AD and OpenLDAP
/// naming attributes.
const DEFAULT_USER_SEARCH_FILTER: &str =
    "(|(sAMAccountName={user})(userPrincipalName={user})(mail={user})(cn={user})(uid={user}))";

/// Split `input` on `sep`, honouring RFC 4514 backslash escapes so that an
/// escaped separator (`\,`) does not split the string.
fn split_unescaped(input: &str, sep: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
        } else if ch == '\\' {
            current.push(ch);
            escaped = true;
        } else if ch == sep {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    parts.push(current);
    parts
}

/// Split at the first *unescaped* occurrence of `sep`.
fn split_once_unescaped(input: &str, sep: char) -> Option<(String, String)> {
    let mut head = String::new();
    let mut escaped = false;
    for (idx, ch) in input.char_indices() {
        if escaped {
            head.push(ch);
            escaped = false;
        } else if ch == '\\' {
            head.push(ch);
            escaped = true;
        } else if ch == sep {
            return Some((head, input[idx + ch.len_utf8()..].to_string()));
        } else {
            head.push(ch);
        }
    }
    None
}

/// RFC 4512 `attributeType`: either a descriptor (`cn`, `sAMAccountName`) or a
/// numeric OID (`2.5.4.3`).
fn is_valid_attribute_type(attr: &str) -> bool {
    let Some(first) = attr.chars().next() else {
        return false;
    };
    if first.is_ascii_digit() {
        return attr.split('.').all(|arc| !arc.is_empty() && arc.chars().all(|c| c.is_ascii_digit()));
    }
    first.is_ascii_alphabetic() && attr.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// RFC 4514 `escaped = ESC ( ESC / special / hexpair )`. A stray `\` (as in
/// `corp\jaime.su`) makes the whole DN unparseable, which is precisely what
/// the server reports as `invalidDNSyntax`.
fn has_valid_dn_escapes(value: &str) -> bool {
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            continue;
        }
        match chars.next() {
            None => return false,
            Some(next) if next.is_ascii_hexdigit() => match chars.peek() {
                Some(second) if second.is_ascii_hexdigit() => {
                    chars.next();
                }
                _ => return false,
            },
            Some(next) => {
                if !matches!(next, ' ' | '"' | '#' | '+' | ',' | ';' | '<' | '=' | '>' | '\\') {
                    return false;
                }
            }
        }
    }
    true
}

/// Whether `candidate` is a syntactically valid distinguished name, i.e. a
/// comma-separated sequence of `attributeType=value` RDNs. This is the check
/// the directory server itself performs before answering `invalidDNSyntax`.
pub fn is_distinguished_name(candidate: &str) -> bool {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return false;
    }
    for rdn in split_unescaped(trimmed, ',') {
        let rdn = rdn.trim();
        if rdn.is_empty() {
            return false;
        }
        for ava in split_unescaped(rdn, '+') {
            let Some((attr, value)) = split_once_unescaped(ava.trim(), '=') else {
                return false;
            };
            if !is_valid_attribute_type(attr.trim()) {
                return false;
            }
            if !has_valid_dn_escapes(&value) {
                return false;
            }
        }
    }
    true
}

/// Escape a value so it can be safely interpolated into a DN component
/// (RFC 4514 §2.4). Prevents both malformed DNs and RDN injection.
pub fn escape_dn_value(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let last = chars.len().saturating_sub(1);
    let mut out = String::with_capacity(value.len());
    for (idx, ch) in chars.iter().copied().enumerate() {
        match ch {
            '"' | '+' | ',' | ';' | '<' | '>' | '=' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            '#' if idx == 0 => out.push_str("\\#"),
            ' ' if idx == 0 || idx == last => out.push_str("\\ "),
            '\0' => out.push_str("\\00"),
            other => out.push(other),
        }
    }
    out
}

/// Escape a value so it can be safely interpolated into a search filter
/// (RFC 4515 §3). Prevents LDAP filter injection via the username.
pub fn escape_filter_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\5c"),
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\0' => out.push_str("\\00"),
            other => out.push(other),
        }
    }
    out
}

/// Split an AD down-level logon name (`CORP\alice`) into its domain and
/// account parts.
fn split_down_level(username: &str) -> Option<(&str, &str)> {
    let (domain, account) = username.split_once('\\')?;
    if domain.is_empty() || account.is_empty() {
        return None;
    }
    Some((domain, account))
}

/// Derive the DNS domain from the `DC=` components of a base DN, e.g.
/// `OU=CLIENTS,DC=CORP,DC=INT,DC=KN` → `CORP.INT.KN`. Used to build a UPN
/// bind identity when the user only supplied a short account name.
fn domain_from_base_dn(base_dn: &str) -> Option<String> {
    let parts: Vec<String> = split_unescaped(base_dn, ',')
        .iter()
        .filter_map(|rdn| {
            let (attr, value) = split_once_unescaped(rdn.trim(), '=')?;
            if !attr.trim().eq_ignore_ascii_case("dc") {
                return None;
            }
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("."))
    }
}

/// Append `candidate` unless an equal entry is already queued.
fn push_unique(candidates: &mut Vec<String>, candidate: String) {
    if candidate.trim().is_empty() {
        return;
    }
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

/// Build the ordered list of bind identities to try for a non-DN principal
/// such as `CORP\alice`, `alice` or `alice@corp.example.com`.
fn bind_identity_candidates(raw: &str, base_dn: &str) -> Vec<String> {
    let raw = raw.trim();
    let mut candidates = Vec::new();
    if raw.is_empty() {
        return candidates;
    }
    // Already a well-formed DN — every server accepts it as-is.
    if is_distinguished_name(raw) {
        candidates.push(raw.to_string());
        return candidates;
    }
    let (domain, account) = split_down_level(raw).unwrap_or(("", raw));
    if account.contains('@') {
        // Already a UPN / email.
        push_unique(&mut candidates, account.to_string());
    } else {
        // `CORP.INT.KN\alice` carries its own FQDN; a NetBIOS-style `CORP\`
        // does not, so fall back to the DC components of the base DN.
        let upn_domain = if domain.contains('.') { Some(domain.to_string()) } else { domain_from_base_dn(base_dn) };
        if let Some(upn_domain) = upn_domain {
            push_unique(&mut candidates, format!("{account}@{upn_domain}"));
        }
    }
    if !domain.is_empty() {
        push_unique(&mut candidates, format!("{domain}\\{account}"));
    }
    push_unique(&mut candidates, account.to_string());
    candidates
}

/// Extract the hexadecimal `data <code>` marker from an Active Directory
/// diagnostic message such as
/// `80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v3839`.
fn ad_data_code(text: &str) -> Option<String> {
    let idx = text.find("data ")?;
    let code: String = text[idx + "data ".len()..].chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if code.is_empty() {
        None
    } else {
        Some(code.to_ascii_lowercase())
    }
}

/// Why a bind attempt failed, and whether the next candidate is worth trying.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BindProbe {
    /// The server rejected the *shape* of the identity without ever checking
    /// the password — safe to try the next candidate.
    TryNext { message: String, dn_syntax: bool },
    /// The server evaluated the credential (or failed hard). Stop.
    Stop(String),
}

fn classify_bind_error(err: &LdapError) -> BindProbe {
    match err {
        LdapError::LdapResult { result } => match result.rc {
            RC_INVALID_DN_SYNTAX => {
                BindProbe::TryNext { message: format!("LDAP bind rejected: {err}"), dn_syntax: true }
            }
            RC_NO_SUCH_OBJECT => BindProbe::TryNext { message: format!("LDAP bind rejected: {err}"), dn_syntax: false },
            RC_INVALID_CREDENTIALS if ad_data_code(&result.text).as_deref() == Some(AD_DATA_USER_NOT_FOUND) => {
                BindProbe::TryNext { message: format!("LDAP bind rejected: {err}"), dn_syntax: false }
            }
            _ => BindProbe::Stop(format!("LDAP bind rejected: {err}")),
        },
        other => BindProbe::Stop(format!("LDAP bind transport error: {other}")),
    }
}

/// Aggregate failure of a whole candidate list.
#[derive(Debug, Clone)]
struct BindFailure {
    message: String,
    /// Every candidate was refused with `invalidDNSyntax`: the server insists
    /// on a real DN, so the caller should resolve one by search.
    dn_lookup_required: bool,
}

impl BindFailure {
    fn fatal(message: impl Into<String>) -> Self {
        Self { message: message.into(), dn_lookup_required: false }
    }
}

/// How the bind DN is built. The SV mode also needs a search filter and a
/// search base to resolve the user's DN.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LdapLogin {
    pub host: String,
    pub port: u16,
    pub use_tls: bool,
    pub base_dn: String,
    /// Optional service account used in SV mode.
    pub service_account_dn: Option<String>,
    pub service_account_password: Option<String>,
    /// Filter used to look up the user's DN in SV mode. `{user}` is replaced
    /// by the supplied (already-normalised) username.
    pub search_filter: Option<String>,
    /// Subtree the SV search starts at. Defaults to `base_dn` when missing.
    pub search_base: Option<String>,
    pub connect_timeout: Duration,
}

impl LdapLogin {
    /// Build a bind URL (e.g. `ldap://host:389` or `ldaps://host:636`).
    pub fn url(&self) -> String {
        let scheme = if self.use_tls { "ldaps" } else { "ldap" };
        format!("{scheme}://{}:{}", self.host, self.port)
    }

    /// Override the host/port/tls settings from a full LDAP URL
    /// (e.g. `ldaps://ad.corp.example.com:636`). Silently ignores malformed
    /// inputs and leaves the previous settings untouched.
    pub fn apply_url_override(&mut self, url: &str) {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return;
        }
        let Some((scheme, rest)) = trimmed.split_once("://") else {
            return;
        };
        let scheme_lower = scheme.to_ascii_lowercase();
        let use_tls = match scheme_lower.as_str() {
            "ldaps" => true,
            "ldap" => false,
            _ => return,
        };
        let (host_port, _path) = match rest.split_once('/') {
            Some((hp, p)) => (hp, p),
            None => (rest, ""),
        };
        let (host, port) = match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(0)),
            None => (host_port.to_string(), 0),
        };
        if host.is_empty() {
            return;
        }
        self.use_tls = use_tls;
        self.host = host;
        if port > 0 {
            self.port = port;
        }
    }

    /// Validate the loaded configuration. Returns the first violation.
    pub fn validate(&self, mode: LdapSupportMode) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("LDAP host is not configured".to_string());
        }
        if self.port == 0 {
            return Err("LDAP port is not configured".to_string());
        }
        if self.base_dn.trim().is_empty() {
            return Err("LDAP base DN is not configured".to_string());
        }
        match mode {
            LdapSupportMode::NoSv => {}
            LdapSupportMode::Sv => {
                if self.service_account_dn.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err("LDAP service account is required in SV mode".to_string());
                }
                if self.service_account_password.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err("LDAP service account password is required in SV mode".to_string());
                }
            }
        }
        Ok(())
    }

    /// Filter used to resolve a user's DN by search, with `{user}` replaced by
    /// the RFC 4515-escaped username.
    fn user_search_filter(&self, username: &str) -> Result<String, String> {
        let template = self
            .search_filter
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_USER_SEARCH_FILTER);
        if !template.contains("{user}") {
            return Err("LDAP search_filter must contain the `{user}` placeholder".to_string());
        }
        Ok(template.replace("{user}", &escape_filter_value(username)))
    }

    /// Bind identities to try for the configured service account, plus its
    /// password. Operators routinely type `CORP\svc-dbx` here, which is not a
    /// DN either, so the same candidate expansion applies.
    fn service_bind_candidates(&self) -> Result<(Vec<String>, String), String> {
        let service_dn = self
            .service_account_dn
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "LDAP service account is not configured".to_string())?;
        let service_pw = self
            .service_account_password
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "LDAP service account password is not configured".to_string())?;
        let candidates = bind_identity_candidates(service_dn, &self.base_dn);
        if candidates.is_empty() {
            return Err("LDAP service account is not configured".to_string());
        }
        Ok((candidates, service_pw.to_string()))
    }

    /// Subtree the user-DN search starts at. Falls back to the base DN.
    fn user_search_base(&self) -> String {
        self.search_base.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(self.base_dn.trim()).to_string()
    }
}

fn empty_string_is_none(s: String) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Default connect timeout used by [`LdapLoginSettings`] when no explicit
/// value is stored.
pub fn default_ldap_connect_timeout_secs() -> u64 {
    10
}

/// App-level LDAP login configuration, persisted in the `app_settings` JSON
/// blob by [`crate::storage::Storage`] and edited from the app settings page.
///
/// This replaces the legacy environment-variable configuration
/// (`LDAP_SUPPORT` / `LDAP_URL` / `LDAP_SV_ACCOUNT` / …). All fields are
/// UI-editable; the service-account password is kept secret and never
/// returned to the client (see [`LdapLoginSettings::redacted`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LdapLoginSettings {
    /// When `false` the LDAP login tab is hidden from the login page.
    #[serde(default)]
    pub enabled: bool,
    /// Display name shown on the login page (e.g. "Corporate Active Directory").
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub use_tls: bool,
    #[serde(default)]
    pub base_dn: String,
    /// When `true`, a service account is used to resolve the user DN before
    /// rebinding with the supplied password (`SV` mode).
    #[serde(default)]
    pub require_service_account: bool,
    #[serde(default)]
    pub service_account_dn: String,
    #[serde(default)]
    pub service_account_password: String,
    /// Search base used to resolve the user DN in `SV` mode. Defaults to
    /// `base_dn` when empty.
    #[serde(default)]
    pub search_base: String,
    /// Search filter used to resolve the user DN in `SV` mode — and in `NOSV`
    /// mode when the directory refuses every non-DN bind identity. The
    /// substring `{user}` is replaced with the RFC 4515-escaped user-supplied
    /// name. Defaults to a filter covering `sAMAccountName`, `uid`,
    /// `userPrincipalName`, `mail` and `cn` when empty.
    #[serde(default)]
    pub search_filter: String,
    #[serde(default = "default_ldap_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
}

impl LdapLoginSettings {
    /// Copy of this config with the service-account password removed. Safe to
    /// return to the client (settings page) so the stored password is never
    /// leaked. The caller can use [`Self::has_service_account_password`] to
    /// let the UI keep the existing password when it is left blank.
    pub fn redacted(&self) -> Self {
        let mut copy = self.clone();
        copy.service_account_password.clear();
        copy
    }

    /// Whether a service-account password is currently stored.
    pub fn has_service_account_password(&self) -> bool {
        !self.service_account_password.is_empty()
    }

    /// Build the runtime [`LdapLogin`] + [`LdapSupportMode`] pair, validating
    /// the configuration on the way.
    pub fn build_login(&self) -> Result<(LdapSupportMode, LdapLogin), String> {
        if self.host.trim().is_empty() {
            return Err("LDAP host is not configured".to_string());
        }
        if self.port == 0 {
            return Err("LDAP port is not configured".to_string());
        }
        if self.base_dn.trim().is_empty() {
            return Err("LDAP base DN is not configured".to_string());
        }
        let mode = if self.require_service_account {
            if self.service_account_dn.trim().is_empty() {
                return Err("LDAP service account DN is not configured".to_string());
            }
            if self.service_account_password.is_empty() {
                return Err("LDAP service account password is not configured".to_string());
            }
            LdapSupportMode::Sv
        } else {
            LdapSupportMode::NoSv
        };
        let login = LdapLogin {
            host: self.host.trim().to_string(),
            port: self.port,
            use_tls: self.use_tls,
            base_dn: self.base_dn.trim().to_string(),
            service_account_dn: empty_string_is_none(self.service_account_dn.clone()),
            service_account_password: empty_string_is_none(self.service_account_password.clone()),
            search_filter: empty_string_is_none(self.search_filter.clone()),
            search_base: empty_string_is_none(self.search_base.clone()),
            connect_timeout: Duration::from_secs(self.connect_timeout_secs.max(1)),
        };
        login.validate(mode)?;
        Ok((mode, login))
    }
}

impl Default for LdapLoginSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            name: String::new(),
            host: String::new(),
            port: 0,
            use_tls: false,
            base_dn: String::new(),
            require_service_account: false,
            service_account_dn: String::new(),
            service_account_password: String::new(),
            search_base: String::new(),
            search_filter: String::new(),
            connect_timeout_secs: default_ldap_connect_timeout_secs(),
        }
    }
}

/// Validate the configuration against the endpoint without performing a full
/// login. For `SV` mode the service-account bind (and a base search) is
/// exercised so misconfigured credentials are caught; for `NOSV` mode only
/// connectivity is verified because the config does not carry any credential
/// to authenticate with.
pub async fn test_connection(settings: &LdapLoginSettings) -> Result<String, String> {
    let (mode, login) = settings.build_login()?;
    let (mut ldap, driver) = open_connection(&login, "connection").await?;

    let bind_outcome = match mode {
        LdapSupportMode::Sv => {
            let (candidates, pw) = login.service_bind_candidates()?;
            bind_candidates_on(&mut ldap, &candidates, &pw, login.connect_timeout)
                .await
                .map(|_| ())
                .map_err(|failure| failure.message)
        }
        LdapSupportMode::NoSv => {
            // Anonymous bind proves the endpoint is reachable and accepts binds.
            match tokio::time::timeout(login.connect_timeout, ldap.simple_bind("", "")).await {
                Err(_) => Err(format!("LDAP bind timed out ({}s)", login.connect_timeout.as_secs())),
                Ok(Err(e)) => Err(format!("LDAP bind failed: {e}")),
                Ok(Ok(op)) => op.success().map(|_| ()).map_err(|e| format!("LDAP bind rejected: {e}")),
            }
        }
    };
    if let Err(err) = bind_outcome {
        let _ = tokio::time::timeout(Duration::from_secs(2), ldap.unbind()).await;
        driver.abort();
        return Err(err);
    }

    let search = tokio::time::timeout(
        login.connect_timeout,
        ldap.search(&login.base_dn, Scope::Base, "(objectClass=*)", vec!["dn"]),
    )
    .await;
    let search_outcome = match search {
        Err(_) => Err("LDAP search timed out".to_string()),
        Ok(Err(e)) => Err(format!("LDAP search failed: {e}")),
        Ok(Ok(_)) => Ok(()),
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), ldap.unbind()).await;
    driver.abort();
    search_outcome?;
    Ok("LDAP connection test succeeded".to_string())
}

/// Try to bind as the supplied user and return the resolved bind DN. The
/// caller should treat any error as a failed login attempt and return
/// `401 UNAUTHORIZED`.
///
/// This is the public entry point used by `dbx-web`'s auth handler.
pub async fn authenticate(
    mode: LdapSupportMode,
    login: &LdapLogin,
    raw_username: &str,
    password: &str,
) -> Result<String, String> {
    if password.is_empty() {
        return Err("Password is required".to_string());
    }
    let username = raw_username.trim();
    if username.is_empty() {
        return Err("Username is required".to_string());
    }
    match mode {
        LdapSupportMode::Sv => {
            let bind_dn = resolve_via_service_account(login, username).await?;
            bind_first_candidate(login, std::slice::from_ref(&bind_dn), password)
                .await
                .map_err(|failure| failure.message)
        }
        LdapSupportMode::NoSv => bind_raw(login, username, password).await,
    }
}

async fn bind_raw(login: &LdapLogin, username: &str, password: &str) -> Result<String, String> {
    let (mut ldap, driver) = open_connection(login, "login connection").await?;
    let attempt = tokio::time::timeout(login.connect_timeout, ldap.simple_bind(username, password)).await;
    let outcome = match attempt {
        Err(_) => Err(format!("LDAP bind timed out ({}s)", login.connect_timeout.as_secs())),
        Ok(Err(e)) => Err(format!("LDAP bind failed: {e}")),
        Ok(Ok(result)) => {
            result.success().map(|_| username.to_string()).map_err(|e| format!("LDAP bind rejected: {e}"))
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), ldap.unbind()).await;
    driver.abort();
    outcome
}

/// Turn a bare `invalidDNSyntax` rejection into an actionable operator hint.
fn dn_syntax_advice(message: &str, candidates: &[String]) -> String {
    let tried = candidates.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ");
    format!(
        "{message} — the directory requires a full distinguished name and rejected every derived bind identity ({tried}). \
Enable the service account so the DN can be resolved by search."
    )
}

/// Open an LDAP connection and spawn its driver task.
async fn open_connection(login: &LdapLogin, what: &str) -> Result<(Ldap, tokio::task::JoinHandle<()>), String> {
    let (conn, ldap) = tokio::time::timeout(login.connect_timeout, LdapConnAsync::new(&login.url()))
        .await
        .map_err(|_| format!("LDAP {what} timed out ({}s)", login.connect_timeout.as_secs()))?
        .map_err(|e| format!("LDAP {what} failed: {e}"))?;
    let driver = tokio::spawn(async move {
        if let Err(err) = conn.drive().await {
            log::warn!("LDAP connection driver exited: {err}");
        }
    });
    Ok((ldap, driver))
}

/// Try each candidate bind identity on an already-open connection and return
/// the one that authenticated.
///
/// Probing stops at the first answer that proves the account exists (wrong
/// password, disabled, locked out, …) so a mistyped password still costs
/// exactly one `badPwdCount` increment.
async fn bind_candidates_on(
    ldap: &mut Ldap,
    candidates: &[String],
    password: &str,
    timeout: Duration,
) -> Result<String, BindFailure> {
    if candidates.is_empty() {
        return Err(BindFailure::fatal("No bind DN candidate could be derived from the supplied username"));
    }
    let mut last_message: Option<String> = None;
    let mut all_dn_syntax = true;
    for candidate in candidates {
        let attempt = tokio::time::timeout(timeout, ldap.simple_bind(candidate, password)).await;
        let err = match attempt {
            Err(_) => return Err(BindFailure::fatal(format!("LDAP bind timed out ({}s)", timeout.as_secs()))),
            Ok(Err(e)) => e,
            Ok(Ok(result)) => match result.success() {
                Ok(_) => return Ok(candidate.clone()),
                Err(e) => e,
            },
        };
        match classify_bind_error(&err) {
            BindProbe::Stop(message) => return Err(BindFailure { message, dn_lookup_required: false }),
            BindProbe::TryNext { message, dn_syntax } => {
                log::debug!("LDAP bind identity `{candidate}` rejected, trying next: {message}");
                all_dn_syntax &= dn_syntax;
                last_message = Some(message);
            }
        }
    }
    Err(BindFailure {
        message: last_message.unwrap_or_else(|| "LDAP bind failed".to_string()),
        dn_lookup_required: all_dn_syntax,
    })
}

/// Open a fresh connection and bind with the first candidate the server
/// accepts.
async fn bind_first_candidate(login: &LdapLogin, candidates: &[String], password: &str) -> Result<String, BindFailure> {
    let (mut ldap, driver) = open_connection(login, "login connection").await.map_err(BindFailure::fatal)?;
    let outcome = bind_candidates_on(&mut ldap, candidates, password, login.connect_timeout).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), ldap.unbind()).await;
    driver.abort();
    outcome
}

/// Strip `DOMAIN\` prefix and `@domain` suffix so the account name can be
/// used in search filters (where `corp\jaime.su` would never match an
/// attribute value).
fn clean_username_for_search(username: &str) -> &str {
    let account = split_down_level(username).map(|(_, a)| a).unwrap_or(username);
    account.split('@').next().unwrap_or(account).trim()
}

/// Run the user-DN search on an already-bound connection.
async fn search_user_dn(ldap: &mut Ldap, login: &LdapLogin, username: &str) -> Result<String, String> {
    let filter = login.user_search_filter(clean_username_for_search(username))?;
    let base_dn = login.user_search_base();
    if base_dn.is_empty() {
        return Err("LDAP base DN is not configured".to_string());
    }
    let search =
        tokio::time::timeout(login.connect_timeout, ldap.search(&base_dn, Scope::Subtree, &filter, vec!["dn"])).await;
    match search {
        Err(_) => Err(format!("LDAP search timed out (base={base_dn}, filter={filter})")),
        Ok(Err(e)) => Err(format!("LDAP search failed: {e} (base={base_dn}, filter={filter})")),
        Ok(Ok(search_result)) => {
            let entries = search_result.0;
            if entries.is_empty() {
                return Err(format!(
                    "LDAP search returned no entries for the supplied user (base={base_dn}, filter={filter})"
                ));
            }
            // Prefer the first entry with a non-empty DN; entries that come
            // back without a DN (referrals) are skipped.
            entries
                .iter()
                .map(|entry| ldap3::SearchEntry::construct(entry.clone()).dn)
                .find(|dn| !dn.trim().is_empty())
                .ok_or_else(|| format!("LDAP search returned entries without a DN (base={base_dn}, filter={filter})"))
        }
    }
}

async fn resolve_via_service_account(login: &LdapLogin, username: &str) -> Result<String, String> {
    let (candidates, service_pw) = login.service_bind_candidates()?;
    let (mut ldap, driver) = open_connection(login, "service connection").await?;

    let bind_outcome =
        bind_candidates_on(&mut ldap, &candidates, &service_pw, login.connect_timeout).await.map_err(|failure| {
            if failure.dn_lookup_required {
                dn_syntax_advice(&failure.message, &candidates)
                    .replace("LDAP bind rejected", "LDAP service bind rejected")
            } else {
                failure.message.replace("LDAP bind rejected", "LDAP service bind rejected")
            }
        });
    let resolved = match bind_outcome {
        Err(err) => Err(err),
        Ok(_) => search_user_dn(&mut ldap, login, username).await,
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), ldap.unbind()).await;
    driver.abort();
    resolved
}

/// Read the `attrs["objectGUID"]` raw bytes from a `ResultEntry`. Used by
/// integration tests that want to confirm a search returned real entries.
pub fn entry_object_guid(entry: &ldap3::SearchEntry) -> Option<Vec<u8>> {
    entry.bin_attrs.get("objectGUID").and_then(|values| values.first().cloned())
}

/// Indirection around the `BASE64` engine so callers don't need a direct
/// `base64` dependency.
pub fn base64_encode(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_sv_login() -> LdapLogin {
        LdapLogin {
            host: "ldap.example.com".into(),
            port: 389,
            use_tls: false,
            base_dn: "DC=corp,DC=example,DC=com".into(),
            service_account_dn: None,
            service_account_password: None,
            search_filter: None,
            search_base: None,
            connect_timeout: Duration::from_secs(5),
        }
    }

    fn sv_login() -> LdapLogin {
        LdapLogin {
            host: "ldap.example.com".into(),
            port: 636,
            use_tls: true,
            base_dn: "DC=corp,DC=example,DC=com".into(),
            service_account_dn: Some("CN=svc,OU=Service,DC=corp,DC=example,DC=com".into()),
            service_account_password: Some("s3cret".into()),
            search_filter: Some("(sAMAccountName={user})".into()),
            search_base: Some("OU=Users,DC=corp,DC=example,DC=com".into()),
            connect_timeout: Duration::from_secs(5),
        }
    }

    fn no_sv_settings() -> LdapLoginSettings {
        LdapLoginSettings {
            enabled: true,
            name: "Corp AD".into(),
            host: "ldap.example.com".into(),
            port: 389,
            use_tls: false,
            base_dn: "DC=corp,DC=example,DC=com".into(),
            require_service_account: false,
            service_account_dn: String::new(),
            service_account_password: String::new(),
            search_base: String::new(),
            search_filter: String::new(),
            connect_timeout_secs: 5,
        }
    }

    fn sv_settings() -> LdapLoginSettings {
        LdapLoginSettings {
            enabled: true,
            name: "Corp AD".into(),
            host: "ldap.example.com".into(),
            port: 636,
            use_tls: true,
            base_dn: "DC=corp,DC=example,DC=com".into(),
            require_service_account: true,
            service_account_dn: "CN=svc,OU=Service,DC=corp,DC=example,DC=com".into(),
            service_account_password: "s3cret".into(),
            search_base: "OU=Users,DC=corp,DC=example,DC=com".into(),
            search_filter: "(sAMAccountName={user})".into(),
            connect_timeout_secs: 5,
        }
    }

    #[test]
    fn settings_build_login_nosv() {
        let (mode, login) = no_sv_settings().build_login().expect("ok");
        assert_eq!(mode, LdapSupportMode::NoSv);
        assert_eq!(login.host, "ldap.example.com");
        assert_eq!(login.port, 389);
    }

    #[test]
    fn settings_build_login_sv() {
        let (mode, login) = sv_settings().build_login().expect("ok");
        assert_eq!(mode, LdapSupportMode::Sv);
        assert_eq!(login.service_account_dn.as_deref(), Some("CN=svc,OU=Service,DC=corp,DC=example,DC=com"));
        assert_eq!(login.service_account_password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn settings_build_login_requires_host_port_base_dn() {
        let mut settings = no_sv_settings();
        settings.host.clear();
        let err = settings.build_login().expect_err("host required");
        assert!(err.contains("host"), "got: {err}");

        let mut settings = no_sv_settings();
        settings.port = 0;
        let err = settings.build_login().expect_err("port required");
        assert!(err.contains("port"), "got: {err}");

        let mut settings = no_sv_settings();
        settings.base_dn.clear();
        let err = settings.build_login().expect_err("base DN required");
        assert!(err.contains("base DN"), "got: {err}");
    }

    #[test]
    fn settings_build_login_sv_requires_service_account_credentials() {
        let mut settings = sv_settings();
        settings.service_account_dn.clear();
        let err = settings.build_login().expect_err("svc dn required");
        assert!(err.contains("service account"), "got: {err}");

        let mut settings = sv_settings();
        settings.service_account_password.clear();
        let err = settings.build_login().expect_err("svc pw required");
        assert!(err.contains("password"), "got: {err}");
    }

    #[test]
    fn settings_redacted_removes_service_account_password() {
        let redacted = sv_settings().redacted();
        assert!(!redacted.has_service_account_password());
        assert_eq!(redacted.service_account_password, "");
        // Everything else survives.
        assert_eq!(redacted.host, "ldap.example.com");
        assert!(redacted.require_service_account);
    }

    #[test]
    fn settings_serialize_round_trips_with_camel_case() {
        let settings = sv_settings();
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: LdapLoginSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, settings);
        assert!(json.contains("\"connectTimeoutSecs\""), "got: {json}");
    }

    #[test]
    fn url_picks_ldap_or_ldaps() {
        let mut login = no_sv_login();
        assert_eq!(login.url(), "ldap://ldap.example.com:389");
        login.use_tls = true;
        login.port = 636;
        assert_eq!(login.url(), "ldaps://ldap.example.com:636");
    }

    #[test]
    fn sv_validation_requires_service_account() {
        let mut login = sv_login();
        login.service_account_dn = None;
        let err = login.validate(LdapSupportMode::Sv).expect_err("svc required");
        assert!(err.contains("service account"), "got: {err}");
        let mut login = sv_login();
        login.service_account_password = None;
        let err = login.validate(LdapSupportMode::Sv).expect_err("svc pw required");
        assert!(err.contains("password"), "got: {err}");
    }

    #[test]
    fn sv_validation_passes_with_service_account() {
        sv_login().validate(LdapSupportMode::Sv).expect("ok");
    }

    // -----------------------------------------------------------------------
    // Regression: `CORP\alice` is not a DN
    //
    // Sending the down-level logon name verbatim made RFC-strict servers
    // answer `rc=34 (invalidDNSyntax) … text: "invalid DN"`. We now derive a
    // list of candidates that starts with shapes a strict server can parse.
    // -----------------------------------------------------------------------

    #[test]
    fn down_level_logon_name_is_not_a_valid_dn() {
        // The exact value that triggered the production failure: no `=`, and
        // `\j` is not a legal RFC 4514 escape.
        assert!(!is_distinguished_name("corp\\jaime.su"));
        assert!(!is_distinguished_name("jaime.su"));
        assert!(!is_distinguished_name("jaime.su@corp.int.kn"));
        assert!(is_distinguished_name("CN=jaime.su,OU=CLIENTS,DC=CORP,DC=INT,DC=KN"));
        assert!(is_distinguished_name("2.5.4.3=jaime.su,DC=corp"));
        // Escaped comma stays inside a single RDN.
        assert!(is_distinguished_name("CN=Doe\\, Jane,OU=Users,DC=corp"));
        assert!(is_distinguished_name("CN=a\\2Cb,DC=corp"));
        // Malformed escapes / missing attribute types are rejected.
        assert!(!is_distinguished_name("CN=alice,corp"));
        assert!(!is_distinguished_name("=alice,DC=corp"));
        assert!(!is_distinguished_name("CN=alice\\"));
        assert!(!is_distinguished_name(""));
    }

    #[test]
    fn dn_escaping_round_trips() {
        assert_eq!(escape_dn_value("plain"), "plain");
        assert_eq!(escape_dn_value("Doe, Jane"), "Doe\\, Jane");
        assert_eq!(escape_dn_value("a+b"), "a\\+b");
        assert_eq!(escape_dn_value("back\\slash"), "back\\\\slash");
        assert_eq!(escape_dn_value(" lead"), "\\ lead");
        assert_eq!(escape_dn_value("trail "), "trail\\ ");
        assert_eq!(escape_dn_value("#hash"), "\\#hash");
        assert!(is_distinguished_name(&format!("CN={},DC=corp", escape_dn_value("a,b=c+d"))));
    }

    #[test]
    fn filter_escaping_blocks_injection() {
        assert_eq!(escape_filter_value("alice"), "alice");
        assert_eq!(escape_filter_value("*"), "\\2a");
        assert_eq!(escape_filter_value("alice)(objectClass=*"), "alice\\29\\28objectClass=\\2a");
        assert_eq!(escape_filter_value("a\\b"), "a\\5cb");
    }

    #[test]
    fn user_search_filter_escapes_the_username() {
        let login = sv_login();
        assert_eq!(login.user_search_filter("alice").unwrap(), "(sAMAccountName=alice)");
        assert_eq!(login.user_search_filter("*)(uid=admin").unwrap(), "(sAMAccountName=\\2a\\29\\28uid=admin)");
    }

    #[test]
    fn user_search_filter_defaults_cover_ad_and_openldap() {
        let mut login = no_sv_login();
        login.search_filter = None;
        let filter = login.user_search_filter("alice").unwrap();
        assert!(filter.contains("(sAMAccountName=alice)"), "got: {filter}");
        assert!(filter.contains("(uid=alice)"), "got: {filter}");
        assert!(filter.contains("(mail=alice)"), "got: {filter}");
    }

    #[test]
    fn user_search_base_falls_back_to_base_dn() {
        let mut login = no_sv_login();
        login.search_base = None;
        assert_eq!(login.user_search_base(), "DC=corp,DC=example,DC=com");
        login.search_base = Some("OU=Staff,DC=corp,DC=example,DC=com".into());
        assert_eq!(login.user_search_base(), "OU=Staff,DC=corp,DC=example,DC=com");
    }

    #[test]
    fn domain_is_derived_from_dc_components() {
        assert_eq!(domain_from_base_dn("OU=CLIENTS,DC=CORP,DC=INT,DC=KN").as_deref(), Some("CORP.INT.KN"));
        assert_eq!(domain_from_base_dn("dc=example,dc=com").as_deref(), Some("example.com"));
        assert_eq!(domain_from_base_dn("OU=Users").as_deref(), None);
        assert_eq!(domain_from_base_dn("").as_deref(), None);
    }

    #[test]
    fn service_bind_candidates_expand_a_down_level_account() {
        let mut login = sv_login();
        login.service_account_dn = Some("CORP\\svc-dbx".into());
        let (candidates, pw) = login.service_bind_candidates().unwrap();
        assert_eq!(pw, "s3cret");
        assert_eq!(
            candidates,
            vec!["svc-dbx@corp.example.com".to_string(), "CORP\\svc-dbx".to_string(), "svc-dbx".to_string(),]
        );
    }

    #[test]
    fn service_bind_candidates_keep_a_real_dn() {
        let login = sv_login();
        let (candidates, _) = login.service_bind_candidates().unwrap();
        assert_eq!(candidates, vec!["CN=svc,OU=Service,DC=corp,DC=example,DC=com".to_string()]);
    }

    // -----------------------------------------------------------------------
    // Bind-failure classification
    // -----------------------------------------------------------------------

    fn ldap_result_error(rc: u32, text: &str) -> LdapError {
        LdapError::LdapResult {
            result: ldap3::LdapResult {
                rc,
                matched: String::new(),
                text: text.to_string(),
                refs: Vec::new(),
                ctrls: Vec::new(),
            },
        }
    }

    #[test]
    fn invalid_dn_syntax_moves_to_the_next_candidate() {
        let probe = classify_bind_error(&ldap_result_error(RC_INVALID_DN_SYNTAX, "invalid DN"));
        assert!(matches!(probe, BindProbe::TryNext { dn_syntax: true, .. }), "got: {probe:?}");
    }

    #[test]
    fn no_such_object_moves_to_the_next_candidate_without_dn_lookup() {
        let probe = classify_bind_error(&ldap_result_error(RC_NO_SUCH_OBJECT, ""));
        assert!(matches!(probe, BindProbe::TryNext { dn_syntax: false, .. }), "got: {probe:?}");
    }

    #[test]
    fn wrong_password_stops_probing_immediately() {
        // AD `data 52e` == wrong password. Probing further identities would
        // burn extra badPwdCount increments and could lock the account out.
        let probe = classify_bind_error(&ldap_result_error(
            RC_INVALID_CREDENTIALS,
            "80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v3839",
        ));
        assert!(matches!(probe, BindProbe::Stop(_)), "got: {probe:?}");
    }

    #[test]
    fn unknown_account_keeps_probing() {
        // AD `data 525` == user not found; no badPwdCount is incremented, so
        // it is safe to try the next identity shape.
        let probe = classify_bind_error(&ldap_result_error(
            RC_INVALID_CREDENTIALS,
            "80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 525, v3839",
        ));
        assert!(matches!(probe, BindProbe::TryNext { dn_syntax: false, .. }), "got: {probe:?}");
    }

    #[test]
    fn locked_out_account_stops_probing() {
        let probe = classify_bind_error(&ldap_result_error(
            RC_INVALID_CREDENTIALS,
            "80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 775, v3839",
        ));
        assert!(matches!(probe, BindProbe::Stop(_)), "got: {probe:?}");
    }

    #[test]
    fn plain_invalid_credentials_stops_probing() {
        // OpenLDAP has no `data` marker — a bare rc=49 means the credential
        // was checked and refused.
        let probe = classify_bind_error(&ldap_result_error(RC_INVALID_CREDENTIALS, ""));
        assert!(matches!(probe, BindProbe::Stop(_)), "got: {probe:?}");
    }

    #[test]
    fn ad_data_code_is_parsed() {
        assert_eq!(ad_data_code("comment: AcceptSecurityContext error, data 52e, v3839").as_deref(), Some("52e"));
        assert_eq!(ad_data_code("invalid DN").as_deref(), None);
    }

    #[test]
    fn dn_syntax_advice_is_actionable() {
        let advice = dn_syntax_advice(
            "LDAP bind rejected: rc=34",
            &["jaime.su@CORP.INT.KN".to_string(), "corp\\jaime.su".to_string()],
        );
        assert!(advice.contains("service account"), "got: {advice}");
        assert!(advice.contains("corp\\jaime.su"), "got: {advice}");
    }

    #[test]
    fn url_override_applies_full_url() {
        let mut login = no_sv_login();
        login.apply_url_override("ldaps://ad.corp.example.com:636");
        assert!(login.use_tls);
        assert_eq!(login.host, "ad.corp.example.com");
        assert_eq!(login.port, 636);
        assert_eq!(login.url(), "ldaps://ad.corp.example.com:636");
    }

    #[test]
    fn url_override_keeps_existing_port_when_url_omits_one() {
        let mut login = no_sv_login();
        login.port = 1389;
        login.apply_url_override("ldap://only-host.example.com");
        assert_eq!(login.host, "only-host.example.com");
        assert_eq!(login.port, 1389, "missing port in URL should not zero out the previous port");
    }

    #[test]
    fn url_override_rejects_unknown_scheme() {
        let mut login = no_sv_login();
        login.apply_url_override("http://example.com:80");
        assert_eq!(login.host, "ldap.example.com", "unknown scheme should leave settings alone");
    }

    // -----------------------------------------------------------------------
    // Integration tests — exercise the login flow against a real LDAP
    // server. Mirrors `LdapAgentTest.java`'s simple-bind scenarios. Only run
    // when `DBX_LDAP_INTEGRATION=1`.
    // -----------------------------------------------------------------------

    fn integration_enabled() -> bool {
        std::env::var("DBX_LDAP_INTEGRATION").is_ok()
    }

    const INTEGRATION_USER: &str = "corp\\jaime.su";
    const INTEGRATION_PASSWORD: &str = "Js@110120(";

    fn integration_login_nosv() -> LdapLogin {
        LdapLogin {
            host: "DC-APAC.CORP.INT.KN".into(),
            port: 389,
            use_tls: false,
            base_dn: "OU=CLIENTS,DC=CORP,DC=INT,DC=KN".into(),
            service_account_dn: None,
            service_account_password: None,
            search_filter: None,
            search_base: None,
            connect_timeout: Duration::from_secs(15),
        }
    }

    fn integration_login_sv(svc_dn: &str, svc_pw: &str) -> LdapLogin {
        LdapLogin {
            host: "DC-APAC.CORP.INT.KN".into(),
            port: 389,
            use_tls: false,
            base_dn: "OU=CLIENTS,DC=CORP,DC=INT,DC=KN".into(),
            service_account_dn: Some(svc_dn.to_string()),
            service_account_password: Some(svc_pw.to_string()),
            search_filter: Some("(sAMAccountName={user})".into()),
            search_base: Some("OU=CLIENTS,DC=CORP,DC=INT,DC=KN".into()),
            connect_timeout: Duration::from_secs(15),
        }
    }

    #[tokio::test]
    async fn integration_nosv_simple_bind_succeeds() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let login = integration_login_nosv();
        let bind_dn = authenticate(LdapSupportMode::NoSv, &login, INTEGRATION_USER, INTEGRATION_PASSWORD)
            .await
            .expect("NOSV simple bind should succeed for corp\\jaime.su");
        assert!(!bind_dn.is_empty(), "resolved bind DN should not be empty, got: {bind_dn}");
    }

    #[tokio::test]
    async fn integration_nosv_simple_bind_rejects_wrong_password() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let login = integration_login_nosv();
        let err = authenticate(LdapSupportMode::NoSv, &login, INTEGRATION_USER, "wrong-password")
            .await
            .expect_err("NOSV simple bind with wrong password should fail");
        assert!(
            err.to_lowercase().contains("bind") || err.to_lowercase().contains("credential"),
            "expected bind/credential error, got: {err}"
        );
    }

    #[tokio::test]
    async fn integration_nosv_simple_bind_rejects_unknown_user() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let login = integration_login_nosv();
        let err = authenticate(LdapSupportMode::NoSv, &login, "corp\\nobody-here-9999", "any-password")
            .await
            .expect_err("NOSV simple bind for an unknown user should fail");
        assert!(
            err.to_lowercase().contains("bind") || err.to_lowercase().contains("credential"),
            "expected bind/credential error, got: {err}"
        );
    }

    #[tokio::test]
    async fn integration_sv_search_then_bind_succeeds() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        // The service account is the same as the target user in the test
        // directory. In a production setup this would be a dedicated svc
        // account; for the integration test we exercise the full SV flow
        // (search → resolve DN → rebind with the user's password).
        let login = integration_login_sv(INTEGRATION_USER, INTEGRATION_PASSWORD);
        let bind_dn = authenticate(LdapSupportMode::Sv, &login, "jaime.su", INTEGRATION_PASSWORD)
            .await
            .expect("SV search-then-bind should succeed");
        assert!(
            bind_dn.to_uppercase().contains("JAIME.SU"),
            "expected resolved DN to mention jaime.su, got: {bind_dn}"
        );
    }

    #[tokio::test]
    async fn integration_sv_search_then_bind_rejects_wrong_password() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let login = integration_login_sv(INTEGRATION_USER, INTEGRATION_PASSWORD);
        let err = authenticate(LdapSupportMode::Sv, &login, "jaime.su", "wrong-password")
            .await
            .expect_err("SV flow with wrong password should fail");
        assert!(
            err.to_lowercase().contains("bind") || err.to_lowercase().contains("credential"),
            "expected bind/credential error, got: {err}"
        );
    }
}
