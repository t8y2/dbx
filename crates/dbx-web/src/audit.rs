//! Opt-in audit log for DBX Web (`DBX_WEB_AUDIT_LOG`).
//!
//! When enabled, every state-changing Web API request made by an authenticated
//! client, every login attempt that reached the password check, every file
//! download and every authenticated `/mcp` JSON-RPC call is appended to a JSON
//! Lines file. Off by default: without the variable no middleware does any
//! work and nothing is written.
//!
//! What a line may contain is decided by an allowlist, never by a denylist:
//! request bodies are parsed only to copy a fixed set of identifying fields
//! (connection id, database, SQL text, plugin method, file paths). Passwords,
//! tokens, whole connection configs, plugin `params`, file contents and
//! terminal keystrokes therefore never reach the file, whatever new fields a
//! route grows later. Session cookies and bearer tokens are recorded only as a
//! short SHA-256 fingerprint so lines of one session can be correlated without
//! the log becoming a credential store.
//!
//! Anonymous noise (requests rejected before authentication, captcha failures,
//! lockout replies) is deliberately not recorded so an unauthenticated client
//! cannot grow the file without bound; the reverse proxy access log covers it.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::header::{HeaderName, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, SET_COOKIE};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::auth::{middleware_api_path_suffix, session_token_from_headers};
use crate::state::WebState;

const ENV_LOG: &str = "DBX_WEB_AUDIT_LOG";
const ENV_USER_HEADER: &str = "DBX_WEB_AUDIT_USER_HEADER";
const ENV_SQL: &str = "DBX_WEB_AUDIT_SQL";

/// Bodies above this size are forwarded untouched and logged without details.
const MAX_CAPTURED_BODY_BYTES: u64 = 2 * 1024 * 1024;
/// Per-field caps keep a single line bounded whatever the client sends.
const MAX_STATEMENT_CHARS: usize = 16 * 1024;
const MAX_PATH_CHARS: usize = 1024;
const MAX_SHORT_CHARS: usize = 256;
const MAX_LISTED_IDS: usize = 50;
const MAX_RPC_BATCH: usize = 20;
/// Lines waiting for the writer thread. A full queue applies back-pressure to
/// the request rather than dropping an audit record.
const QUEUE_CAPACITY: usize = 4096;
const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

/// Headers that carry credentials must never be copied into the log, even if
/// an operator points `DBX_WEB_AUDIT_USER_HEADER` at one by mistake — for
/// example oauth2-proxy's `X-Forwarded-Access-Token` next to
/// `X-Forwarded-Email`. Matched as substrings of the lowercase name.
const FORBIDDEN_USER_HEADER_PARTS: &[&str] = &["cookie", "authorization", "token", "secret", "password", "api-key"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatementMode {
    /// SQL / command text (truncated) plus its SHA-256.
    Full,
    /// Only the SHA-256 and length, for deployments where statement text may
    /// hold personal data or inline secrets.
    Hash,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditConfig {
    pub path: PathBuf,
    pub user_header: Option<HeaderName>,
    pub statements: StatementMode,
}

impl AuditConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::from_values(
            std::env::var(ENV_LOG).ok().as_deref(),
            std::env::var(ENV_USER_HEADER).ok().as_deref(),
            std::env::var(ENV_SQL).ok().as_deref(),
        )
    }

    pub fn from_values(
        log: Option<&str>,
        user_header: Option<&str>,
        statements: Option<&str>,
    ) -> Result<Option<Self>, String> {
        let Some(path) = log.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let user_header = match user_header.map(str::trim).filter(|value| !value.is_empty()) {
            None => None,
            Some(raw) => {
                let name = HeaderName::from_bytes(raw.to_ascii_lowercase().as_bytes())
                    .map_err(|_| format!("{ENV_USER_HEADER} is not a valid HTTP header name: {raw:?}"))?;
                if FORBIDDEN_USER_HEADER_PARTS.iter().any(|part| name.as_str().contains(part)) {
                    return Err(format!("{ENV_USER_HEADER} must not name a credential header ({name})"));
                }
                Some(name)
            }
        };
        let statements = match statements.map(|value| value.trim().to_ascii_lowercase()) {
            None => StatementMode::Full,
            Some(value) if value.is_empty() || value == "full" => StatementMode::Full,
            Some(value) if value == "hash" => StatementMode::Hash,
            Some(value) => return Err(format!("{ENV_SQL} must be \"full\" or \"hash\", got {value:?}")),
        };
        Ok(Some(Self { path: PathBuf::from(path), user_header, statements }))
    }
}

enum WriterMessage {
    Line(String),
    Flush(oneshot::Sender<()>),
}

pub struct AuditLog {
    sender: mpsc::Sender<WriterMessage>,
    user_header: Option<HeaderName>,
    statements: StatementMode,
}

impl AuditLog {
    /// Opens (creating with mode 0600) the configured file and starts the
    /// writer thread. Fails instead of degrading silently: an operator who
    /// asked for an audit trail must not get a server without one.
    pub fn open(config: AuditConfig) -> Result<Arc<Self>, String> {
        let file = open_audit_file(&config.path)?;
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let path = config.path.clone();
        std::thread::Builder::new()
            .name("dbx-web-audit".to_string())
            .spawn(move || writer_loop(file, receiver, &path))
            .map_err(|error| format!("Failed to start the audit log writer: {error}"))?;
        Ok(Arc::new(Self { sender, user_header: config.user_header, statements: config.statements }))
    }

    async fn record(&self, entry: &AuditEntry) {
        let mut line = match serde_json::to_string(entry) {
            Ok(line) => line,
            Err(error) => {
                tracing::error!("Failed to serialize audit entry: {error}");
                return;
            }
        };
        line.push('\n');
        if self.sender.send(WriterMessage::Line(line)).await.is_err() {
            tracing::error!("Audit log writer stopped; audit entry lost");
        }
    }

    /// Waits until every queued line has been written and flushed. Used at
    /// shutdown so the last actions are not lost, and by tests.
    pub async fn flush(&self) {
        let (ack, done) = oneshot::channel();
        if self.sender.send(WriterMessage::Flush(ack)).await.is_ok() {
            let _ = tokio::time::timeout(FLUSH_TIMEOUT, done).await;
        }
    }
}

fn open_audit_file(path: &Path) -> Result<File, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!("{ENV_LOG} must not be a symbolic link: {}", path.display()));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!("{ENV_LOG} must be a regular file: {}", path.display()));
        }
        Ok(_metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if _metadata.permissions().mode() & 0o077 != 0 {
                    tracing::warn!(
                        "Audit log {} is readable or writable by other users; consider chmod 600",
                        path.display()
                    );
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect audit log {}: {error}", path.display())),
    }

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| format!("Cannot open audit log {}: {error}", path.display()))
}

struct WriteHealth<'a> {
    path: &'a Path,
    failing: bool,
}

impl WriteHealth<'_> {
    /// Reports only the first failure of a streak, so a full disk does not
    /// also flood the process log.
    fn observe(&mut self, result: std::io::Result<()>) {
        match result {
            Ok(()) if self.failing => {
                tracing::info!("Audit log {} is writable again", self.path.display());
                self.failing = false;
            }
            Ok(()) => {}
            Err(error) if !self.failing => {
                tracing::error!("Failed to write audit log {}: {error}", self.path.display());
                self.failing = true;
            }
            Err(_) => {}
        }
    }
}

fn writer_loop(file: File, mut receiver: mpsc::Receiver<WriterMessage>, path: &Path) {
    let mut writer = BufWriter::new(file);
    let mut health = WriteHealth { path, failing: false };
    while let Some(first) = receiver.blocking_recv() {
        let mut acks = Vec::new();
        let mut next = Some(first);
        // Drain whatever is already queued so a burst costs one flush.
        while let Some(message) = next.take().or_else(|| receiver.try_recv().ok()) {
            match message {
                WriterMessage::Line(line) => health.observe(writer.write_all(line.as_bytes())),
                WriterMessage::Flush(ack) => acks.push(ack),
            }
        }
        health.observe(writer.flush());
        for ack in acks {
            let _ = ack.send(());
        }
    }
    let _ = writer.flush();
}

#[derive(Debug, Serialize)]
struct AuditEntry {
    ts: String,
    channel: &'static str,
    action: String,
    method: String,
    status: u16,
    outcome: &'static str,
    duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forwarded_for: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    details: Map<String, Value>,
}

impl AuditEntry {
    fn new(audit: &AuditLog, channel: &'static str, request: &Request<Body>, action: String) -> Self {
        let headers = request.headers();
        Self {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            channel,
            action: truncate(&action, MAX_PATH_CHARS).0,
            method: request.method().to_string(),
            status: 0,
            outcome: "ok",
            duration_ms: 0,
            peer: request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip().to_string()),
            forwarded_for: header_text(headers, &HeaderName::from_static("x-forwarded-for")),
            user: audit.user_header.as_ref().and_then(|name| header_text(headers, name)),
            session: None,
            details: Map::new(),
        }
    }

    fn finish(&mut self, status: StatusCode, started: Instant) {
        self.status = status.as_u16();
        self.outcome = match status.as_u16() {
            100..=399 => "ok",
            401 | 403 => "denied",
            _ => "error",
        };
        self.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    }
}

/// Header value as text, all occurrences joined so a proxy that appends
/// instead of overwriting is visible in the log rather than hidden.
fn header_text(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    let values: Vec<String> =
        headers.get_all(name).iter().map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned()).collect();
    if values.is_empty() {
        return None;
    }
    Some(truncate(&values.join(", "), MAX_SHORT_CHARS).0)
}

/// Correlation id for a credential: the first 64 bits of its SHA-256. The
/// credential itself cannot be recovered from it.
fn fingerprint(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn truncate(text: &str, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((byte_index, _)) => (text[..byte_index].to_string(), true),
        None => (text.to_string(), false),
    }
}

fn session_from_set_cookie(headers: &HeaderMap) -> Option<String> {
    headers.get_all(SET_COOKIE).iter().find_map(|value| {
        let cookie = value.to_str().ok()?;
        let token = cookie.split(';').next()?.trim().strip_prefix("dbx_session=")?;
        (!token.is_empty()).then(|| fingerprint(token))
    })
}

// ---------------------------------------------------------------------------
// Which requests are recorded
// ---------------------------------------------------------------------------

/// Side-effect-free helpers the editor calls while the user types or browses:
/// SQL builders, parsers, capability probes and client-side caches. They would
/// drown the meaningful entries; their effect, if any, is recorded when the
/// generated SQL is executed.
const QUIET_EXACT: &[&str] = &[
    "plugins/binary",
    "query/find-statement-at-cursor",
    "query/plugin-plan-capabilities",
    "connection/check-health",
    "connection/is-open",
    "connection/session-credential-status",
    "connection/write-unlock/state",
    "connection/final-proxy-port",
    "connection/identifier-quote",
    "schema/completion-assistant",
    "history/save",
    "layout",
];
const QUIET_PREFIXES: &[&str] = &[
    "query/build-",
    "query/analyze-",
    "query/parse-",
    "query/rewrite-",
    "query/review-",
    "query/supports-",
    "query/prepare-",
    "dialect/",
    "schema/cache",
    "tab-runtime-cache",
];

/// Read-only routes that still matter for an audit: data leaving the server.
fn is_audited_read(suffix: &str) -> bool {
    suffix.contains("/download/")
        || (suffix.starts_with("database-backups/") && suffix.contains("/files/"))
        || (suffix.starts_with("sql-file/failure-log/") && !suffix.ends_with("/info"))
        || suffix == "ssh/config-hosts"
        || suffix == "redis/pubsub/ws"
}

fn is_audited_api_request(method: &Method, suffix: &str) -> bool {
    if *method == Method::GET || *method == Method::HEAD {
        return is_audited_read(suffix);
    }
    if *method == Method::OPTIONS {
        return false;
    }
    !(QUIET_EXACT.contains(&suffix) || QUIET_PREFIXES.iter().any(|prefix| suffix.starts_with(prefix)))
}

/// `auth/login` and `auth/setup` are reachable without a session. Only the
/// replies that prove the password check ran are recorded: a successful login
/// or setup, and a wrong password (bounded by the login lockout). Replies an
/// anonymous client can trigger at will — missing captcha, lockout, setup
/// already done, no password configured — are left to the proxy access log.
/// The other auth routes require a session and are always recorded.
fn is_recorded_auth_status(suffix: &str, status: StatusCode) -> bool {
    match suffix {
        "auth/login" => status.is_success() || status == StatusCode::UNAUTHORIZED,
        "auth/setup" => status.is_success(),
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Request body details (allowlist)
// ---------------------------------------------------------------------------

enum Captured {
    Json(Value),
    Skipped(&'static str),
    None,
}

/// Buffers a JSON body of known, bounded size so its allowlisted fields can be
/// logged, and hands an identical body to the handler. Bodies that are not
/// JSON, too large or of unknown length pass through untouched.
async fn capture_json_body(request: Request<Body>) -> Result<(Request<Body>, Captured), Response> {
    let is_json = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("json"));
    if !is_json {
        return Ok((request, Captured::None));
    }
    let length = request.headers().get(CONTENT_LENGTH).and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    match length {
        None => return Ok((request, Captured::Skipped("body_length_unknown"))),
        Some(length) if length > MAX_CAPTURED_BODY_BYTES => return Ok((request, Captured::Skipped("body_too_large"))),
        Some(_) => {}
    }
    let (parts, body) = request.into_parts();
    // `Content-Length` is enforced by the HTTP layer, so the limit only trips
    // on a malformed or aborted request, which the handler would reject too.
    let bytes = axum::body::to_bytes(body, MAX_CAPTURED_BODY_BYTES as usize)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST.into_response())?;
    let captured = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => Captured::Json(value),
        Err(_) => Captured::Skipped("body_not_json"),
    };
    Ok((Request::from_parts(parts, Body::from(bytes)), captured))
}

fn short_text(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => Some(Value::String(truncate(text, MAX_SHORT_CHARS).0)),
        Value::Number(_) | Value::Bool(_) => Some(value.clone()),
        _ => None,
    }
}

fn path_text(value: &Value) -> Option<Value> {
    value.as_str().map(|text| Value::String(truncate(text, MAX_PATH_CHARS).0))
}

/// Ids from an array of scalars, or from the `field` of an array of objects.
fn id_list(value: &Value, field: Option<&str>) -> Option<Value> {
    let items = value.as_array()?;
    let ids: Vec<Value> = items
        .iter()
        .filter_map(|item| match field {
            Some(field) => item.get(field),
            None => Some(item),
        })
        .filter_map(short_text)
        .take(MAX_LISTED_IDS)
        .collect();
    Some(Value::Array(ids))
}

const MASK: &str = "***";

fn is_bare_secret_char(byte: u8) -> bool {
    !(byte.is_ascii_whitespace() || matches!(byte, b',' | b';' | b')' | b'&' | b'\'' | b'"'))
}

/// Best-effort masking of credentials written inline in SQL or shell
/// commands: `IDENTIFIED BY 'x'` / `IDENTIFIED BY x`, `PASSWORD 'x'`,
/// `PASSWORD = 'x'`, `password=x`, `--password=x`. Quoted literals keep their
/// quotes. This narrows, but does not remove, the need to protect the file.
fn mask_secret_literals(text: &str) -> String {
    let bytes = text.as_bytes();
    // ASCII lowercasing keeps byte offsets aligned with `text`.
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut cursor = 0;
    while cursor < bytes.len() {
        // Byte slices: `cursor` may sit inside a multi-byte character.
        let rest = &lower.as_bytes()[cursor..];
        let (keyword_len, bare_allowed) = if rest.starts_with(b"identified by") {
            ("identified by".len(), true)
        } else if rest.starts_with(b"password") {
            ("password".len(), false)
        } else {
            cursor += 1;
            continue;
        };
        let mut index = cursor + keyword_len;
        let skip_spaces = |mut index: usize| {
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            index
        };
        if keyword_len == "identified by".len() && index < bytes.len() && !bytes[index].is_ascii_whitespace() {
            cursor += 1;
            continue;
        }
        index = skip_spaces(index);
        let mut assigned = false;
        if index < bytes.len() && matches!(bytes[index], b'=' | b':') {
            assigned = true;
            index = skip_spaces(index + 1);
        }
        if index >= bytes.len() {
            break;
        }
        // N'…' (SQL Server unicode) and E'…' (PostgreSQL escape) literals.
        if matches!(bytes[index], b'N' | b'n' | b'E' | b'e') && matches!(bytes.get(index + 1), Some(b'\'')) {
            index += 1;
        }
        let quote = bytes[index];
        let (secret_start, secret_end) = if quote == b'\'' || quote == b'"' {
            // Doubled quotes and backslash escapes (MySQL, E'…') stay inside
            // the literal. Where a backslash is not an escape this masks a
            // little more than the literal, which errs on the safe side.
            let mut end = index + 1;
            loop {
                match bytes[end..].iter().position(|byte| *byte == quote || *byte == b'\\') {
                    Some(offset) if bytes[end + offset] == b'\\' => end += offset + 2,
                    Some(offset) if bytes.get(end + offset + 1) == Some(&quote) => end += offset + 2,
                    Some(offset) => break (index + 1, end + offset),
                    None => break (index + 1, bytes.len()),
                }
                if end >= bytes.len() {
                    break (index + 1, bytes.len());
                }
            }
        } else if bare_allowed || assigned {
            let mut end = index;
            while end < bytes.len() && is_bare_secret_char(bytes[end]) {
                end += 1;
            }
            (index, end)
        } else {
            cursor = index;
            continue;
        };
        if secret_end > secret_start {
            out.push_str(&text[copied..secret_start]);
            out.push_str(MASK);
            copied = secret_end;
        }
        cursor = secret_end.max(cursor + 1);
    }
    out.push_str(&text[copied..]);
    out
}

fn record_statement(details: &mut Map<String, Value>, key: &str, text: &str, mode: StatementMode) {
    // Hash the masked text: a digest of a statement whose only unknown part is
    // a password would let anyone holding the log brute-force that password.
    let text = mask_secret_literals(text);
    let text = text.as_str();
    details.insert(format!("{key}_sha256"), Value::String(sha256_hex(text)));
    match mode {
        StatementMode::Full => {
            let (kept, truncated) = truncate(text, MAX_STATEMENT_CHARS);
            details.insert(key.to_string(), Value::String(kept));
            if truncated {
                details.insert(format!("{key}_truncated"), Value::Bool(true));
            }
        }
        StatementMode::Hash => {
            details.insert(format!("{key}_chars"), Value::from(text.chars().count()));
        }
    }
}

/// Copies the allowlisted fields of a request (or MCP tool arguments) object.
/// Anything not named here — passwords, tokens, configs, params, file data —
/// is ignored by construction.
fn extract_details(body: &Value, mode: StatementMode, details: &mut Map<String, Value>) {
    let Some(object) = body.as_object() else {
        return;
    };
    for (key, value) in object {
        let short_key = match key.as_str() {
            "connectionId" | "connection_id" => Some("connection_id"),
            "database" => Some("database"),
            "schema" => Some("schema"),
            "catalog" => Some("catalog"),
            "table" => Some("table"),
            "pluginId" | "plugin_id" => Some("plugin_id"),
            "providerId" | "provider_id" => Some("provider_id"),
            "method" => Some("method"),
            "actionId" | "action_id" => Some("action_id"),
            "recursive" => Some("recursive"),
            "overwrite" => Some("overwrite"),
            "create" => Some("create"),
            _ => None,
        };
        if let Some(short_key) = short_key {
            if let Some(value) = short_text(value) {
                details.insert(short_key.to_string(), value);
            }
            continue;
        }
        match key.as_str() {
            "uri" | "path" => {
                if let Some(value) = path_text(value) {
                    details.insert(key.clone(), value);
                }
            }
            "sourceUri" | "source_uri" => {
                if let Some(value) = path_text(value) {
                    details.insert("source_uri".to_string(), value);
                }
            }
            "targetUri" | "target_uri" => {
                if let Some(value) = path_text(value) {
                    details.insert("target_uri".to_string(), value);
                }
            }
            "sql" | "statement" | "command" | "query" => {
                let text = match value {
                    Value::String(text) => text.clone(),
                    Value::Null => continue,
                    // Document-store queries arrive as objects.
                    other => other.to_string(),
                };
                record_statement(details, key, &text, mode);
            }
            "statements" => {
                if let Some(items) = value.as_array() {
                    let joined = items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(";\n");
                    details.insert("statement_count".to_string(), Value::from(items.len()));
                    record_statement(details, "statements", &joined, mode);
                }
            }
            "config" => {
                if let Some(config) = value.as_object() {
                    let mut target = Map::new();
                    for field in ["id", "name", "db_type", "host", "port", "username"] {
                        if let Some(value) = config.get(field).and_then(short_text) {
                            target.insert(field.to_string(), value);
                        }
                    }
                    if !target.is_empty() {
                        details.insert("target".to_string(), Value::Object(target));
                    }
                }
            }
            "configs" => {
                if let Some(ids) = id_list(value, Some("id")) {
                    details.insert("connection_ids".to_string(), ids);
                }
            }
            "removedIds" | "removed_ids" => {
                if let Some(ids) = id_list(value, None) {
                    details.insert("removed_ids".to_string(), ids);
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/// Audits `/api/*`. Mounted inside the auth middleware, so it only sees
/// authenticated requests plus the bootstrap auth routes that bypass it.
pub async fn api_audit_middleware(State(state): State<Arc<WebState>>, request: Request<Body>, next: Next) -> Response {
    let Some(audit) = state.audit.clone() else {
        return next.run(request).await;
    };
    let Some(suffix) = middleware_api_path_suffix(request.uri().path(), &state.public_base_path).map(str::to_owned)
    else {
        return next.run(request).await;
    };
    if !is_audited_api_request(request.method(), &suffix) {
        return next.run(request).await;
    }

    let started = Instant::now();
    let mut entry = AuditEntry::new(&audit, "api", &request, suffix.clone());
    entry.session = session_token_from_headers(request.headers()).map(|token| fingerprint(&token));

    // Auth bodies carry passwords and are size-limited by their routes before
    // the session check; never buffer or inspect them.
    let request = if suffix.starts_with("auth/") {
        request
    } else {
        match capture_json_body(request).await {
            Ok((request, captured)) => {
                match captured {
                    Captured::Json(body) => extract_details(&body, audit.statements, &mut entry.details),
                    Captured::Skipped(reason) => {
                        entry.details.insert("details".to_string(), Value::String(reason.to_string()));
                    }
                    Captured::None => {}
                }
                request
            }
            Err(response) => {
                entry.finish(response.status(), started);
                audit.record(&entry).await;
                return response;
            }
        }
    };

    let response = next.run(request).await;
    if suffix.starts_with("auth/") && !is_recorded_auth_status(&suffix, response.status()) {
        return response;
    }
    if entry.session.is_none() {
        // login / setup: tie the new session to this request.
        entry.session = session_from_set_cookie(response.headers());
    }
    entry.finish(response.status(), started);
    audit.record(&entry).await;
    response
}

/// Audits the native `/mcp` endpoint. The MCP router authenticates bearer
/// tokens itself and rejects some anonymous requests (origin, host) before
/// that, so this outer layer checks the token with the router's own
/// comparison and leaves anything not carrying it untouched and unrecorded.
pub async fn mcp_audit_middleware(State(state): State<Arc<WebState>>, request: Request<Body>, next: Next) -> Response {
    let Some(audit) = state.audit.clone() else {
        return next.run(request).await;
    };
    if !matches!(*request.method(), Method::POST | Method::DELETE) {
        return next.run(request).await;
    }
    let authorization = request.headers().get(AUTHORIZATION);
    if !state.web_mcp.auth().bearer_is_valid(authorization) {
        return next.run(request).await;
    }

    let started = Instant::now();
    let mut entry = AuditEntry::new(&audit, "mcp", &request, "mcp".to_string());
    entry.session = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .map(|(_, token)| format!("mcp:{}", fingerprint(token)));

    let (request, captured) = match capture_json_body(request).await {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let mut calls = Vec::new();
    match &captured {
        Captured::Json(Value::Array(batch)) => calls.extend(batch.iter().take(MAX_RPC_BATCH)),
        Captured::Json(single) => calls.push(single),
        Captured::Skipped(reason) => {
            entry.details.insert("details".to_string(), Value::String(reason.to_string()));
        }
        Captured::None => {}
    }
    let mut rpc_methods = Vec::new();
    for call in &calls {
        let Some(method) = call.get("method").and_then(Value::as_str) else {
            continue;
        };
        rpc_methods.push(method.to_string());
        if method == "tools/call" {
            let params = call.get("params");
            if let Some(tool) = params.and_then(|params| params.get("name")).and_then(short_text) {
                entry.details.insert("tool".to_string(), tool);
            }
            if let Some(arguments) = params.and_then(|params| params.get("arguments")) {
                extract_details(arguments, audit.statements, &mut entry.details);
            }
        }
    }
    // Keep-alives and client notifications are protocol noise.
    let only_noise = !rpc_methods.is_empty()
        && rpc_methods.iter().all(|method| method == "ping" || method.starts_with("notifications/"));
    if let Some(first) = rpc_methods.first() {
        entry.action = truncate(&format!("mcp/{first}"), MAX_PATH_CHARS).0;
    }

    let response = next.run(request).await;
    if only_noise {
        return response;
    }
    entry.finish(response.status(), started);
    audit.record(&entry).await;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::Router;

    fn details_of(body: Value, mode: StatementMode) -> Map<String, Value> {
        let mut details = Map::new();
        extract_details(&body, mode, &mut details);
        details
    }

    #[test]
    fn config_is_off_unless_a_path_is_set() {
        assert_eq!(AuditConfig::from_values(None, Some("x-user"), Some("hash")).unwrap(), None);
        assert_eq!(AuditConfig::from_values(Some("  "), None, None).unwrap(), None);
        let config = AuditConfig::from_values(Some("/data/audit.jsonl"), None, None).unwrap().unwrap();
        assert_eq!(config.path, PathBuf::from("/data/audit.jsonl"));
        assert_eq!(config.user_header, None);
        assert_eq!(config.statements, StatementMode::Full);
    }

    #[test]
    fn config_validates_user_header_and_statement_mode() {
        let config =
            AuditConfig::from_values(Some("/a.jsonl"), Some("X-Forwarded-Email"), Some(" HASH ")).unwrap().unwrap();
        assert_eq!(config.user_header.unwrap().as_str(), "x-forwarded-email");
        assert_eq!(config.statements, StatementMode::Hash);

        for header in ["Cookie", "authorization", "Proxy-Authorization", "X-Forwarded-Access-Token", "X-Api-Key"] {
            let error = AuditConfig::from_values(Some("/a.jsonl"), Some(header), None).unwrap_err();
            assert!(error.contains("credential header"), "{header}: {error}");
        }
        assert!(AuditConfig::from_values(Some("/a.jsonl"), Some("bad header"), None).is_err());
        assert!(AuditConfig::from_values(Some("/a.jsonl"), None, Some("redact")).is_err());
    }

    #[test]
    fn request_selection_skips_helpers_and_plain_reads() {
        for (method, suffix) in [
            (Method::POST, "query/execute"),
            (Method::POST, "query/execute-script"),
            (Method::POST, "connection/connect"),
            (Method::POST, "connection/save"),
            (Method::POST, "plugins/invoke"),
            (Method::POST, "plugins/filesystem/delete"),
            (Method::DELETE, "history/entry-1"),
            (Method::POST, "auth/logout"),
            (Method::GET, "export/table/download/exp-1"),
            (Method::GET, "database-backups/b1/files/0"),
            (Method::GET, "ssh/config-hosts"),
        ] {
            assert!(is_audited_api_request(&method, suffix), "expected audited: {method} {suffix}");
        }
        for (method, suffix) in [
            (Method::GET, "connection/list"),
            (Method::GET, "plugins/events"),
            (Method::GET, "sql-file/failure-log/run-1/info"),
            (Method::OPTIONS, "query/execute"),
            (Method::POST, "plugins/binary"),
            (Method::POST, "query/build-drop-table-sql"),
            (Method::POST, "query/find-statement-at-cursor"),
            (Method::POST, "connection/is-open"),
            (Method::POST, "schema/cache"),
        ] {
            assert!(!is_audited_api_request(&method, suffix), "expected quiet: {method} {suffix}");
        }
    }

    #[test]
    fn details_copy_allowlisted_fields_and_never_secrets() {
        let details = details_of(
            serde_json::json!({
                "connectionId": "pg-1",
                "database": "sales",
                "sql": "select 1",
                "password": "hunter2",
                "token": "t",
                "params": {"password": "x"},
                "dataBase64": "c2VjcmV0",
                "config": {
                    "id": "pg-1", "name": "Prod", "db_type": "postgres", "host": "db", "port": 5432,
                    "username": "app", "password": "hunter2", "ssh_password": "x"
                },
                "configs": [{"id": "a", "password": "p"}, {"id": "b"}],
                "removedIds": ["c"]
            }),
            StatementMode::Full,
        );
        let line = serde_json::to_string(&details).unwrap();
        assert!(!line.contains("hunter2") && !line.contains("c2VjcmV0") && !line.contains("\"p\""), "{line}");
        assert_eq!(details["connection_id"], "pg-1");
        assert_eq!(details["database"], "sales");
        assert_eq!(details["sql"], "select 1");
        assert_eq!(details["sql_sha256"], sha256_hex("select 1"));
        assert_eq!(details["target"]["host"], "db");
        assert_eq!(details["target"]["port"], 5432);
        assert!(details["target"].get("password").is_none());
        assert_eq!(details["connection_ids"], serde_json::json!(["a", "b"]));
        assert_eq!(details["removed_ids"], serde_json::json!(["c"]));
    }

    #[test]
    fn statements_are_truncated_or_hashed() {
        let long = "x".repeat(MAX_STATEMENT_CHARS + 10);
        let full = details_of(serde_json::json!({ "sql": long }), StatementMode::Full);
        assert_eq!(full["sql"].as_str().unwrap().chars().count(), MAX_STATEMENT_CHARS);
        assert_eq!(full["sql_truncated"], true);
        assert_eq!(full["sql_sha256"], sha256_hex(&long));

        let hashed = details_of(
            serde_json::json!({ "statements": ["delete from t", "commit"], "command": "rm -rf /tmp/x" }),
            StatementMode::Hash,
        );
        assert!(hashed.get("statements").is_none() && hashed.get("command").is_none());
        assert_eq!(hashed["statement_count"], 2);
        assert_eq!(hashed["statements_sha256"], sha256_hex("delete from t;\ncommit"));
        assert_eq!(hashed["command_chars"], 13);
    }

    #[test]
    fn inline_credentials_are_masked_before_logging_and_hashing() {
        let cases = [
            ("CREATE USER bob IDENTIFIED BY 'S3cr''et!'", "CREATE USER bob IDENTIFIED BY '***'"),
            ("alter user bob identified by Tiger123;", "alter user bob identified by ***;"),
            ("CREATE ROLE app LOGIN PASSWORD 'pw'", "CREATE ROLE app LOGIN PASSWORD '***'"),
            ("CREATE LOGIN app WITH PASSWORD = N'pw'", "CREATE LOGIN app WITH PASSWORD = N'***'"),
            ("ALTER ROLE app PASSWORD E'p\\'w'", "ALTER ROLE app PASSWORD E'***'"),
            ("SET PASSWORD = 'a\\\\' -- next", "SET PASSWORD = '***' -- next"),
            ("password 'unterminated", "password '***"),
            ("ALTER LOGIN app WITH PASSWORD = 'pw' MUST_CHANGE", "ALTER LOGIN app WITH PASSWORD = '***' MUST_CHANGE"),
            ("update users set password = \"x y\" where id = 1", "update users set password = \"***\" where id = 1"),
            ("mysqldump --password=hunter2 db", "mysqldump --password=*** db"),
            ("select password, name from users", "select password, name from users"),
            ("select password_hash from users", "select password_hash from users"),
            ("-- è password 'ü' àà", "-- è password '***' àà"),
            ("password", "password"),
            ("identified by", "identified by"),
        ];
        for (input, expected) in cases {
            assert_eq!(mask_secret_literals(input), expected, "{input}");
        }

        let sql = "CREATE USER bob IDENTIFIED BY 'S3cret'";
        let details = details_of(serde_json::json!({ "sql": sql }), StatementMode::Full);
        assert_eq!(details["sql"], "CREATE USER bob IDENTIFIED BY '***'");
        assert_eq!(details["sql_sha256"], sha256_hex("CREATE USER bob IDENTIFIED BY '***'"));
        assert!(!serde_json::to_string(&details).unwrap().contains("S3cret"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("àèìòù", 3), ("àèì".to_string(), true));
        assert_eq!(truncate("abc", 3), ("abc".to_string(), false));
    }

    #[test]
    fn fingerprint_is_stable_and_does_not_contain_the_secret() {
        let token = "2f6c0a0e-6d0e-4c43-9c55-0a6f1f6e2b8b";
        assert_eq!(fingerprint(token), fingerprint(token));
        assert_eq!(fingerprint(token).len(), 16);
        assert!(!fingerprint(token).contains("2f6c0a0e"));
    }

    #[cfg(unix)]
    #[test]
    fn audit_file_is_private_and_symlinks_are_refused() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audit.jsonl");
        open_audit_file(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        let link = directory.path().join("link.jsonl");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(open_audit_file(&link).unwrap_err().contains("symbolic link"));
        assert!(open_audit_file(directory.path()).unwrap_err().contains("regular file"));
    }

    async fn serve(router: Router) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap()
        });
        (address, server)
    }

    fn read_lines(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("each audit line is JSON"))
            .collect()
    }

    async fn test_state(directory: &Path, user_header: Option<&str>) -> (Arc<WebState>, PathBuf) {
        let storage = dbx_core::persistence::test_storage::open_unmigrated(&directory.join("dbx.db")).await.unwrap();
        let app = Arc::new(dbx_core::connection::AppState::new(storage));
        let log_path = directory.join("audit.jsonl");
        let config = AuditConfig::from_values(Some(log_path.to_str().unwrap()), user_header, None).unwrap().unwrap();
        let mut state = WebState::for_tests(app, directory.to_path_buf());
        state.audit = Some(AuditLog::open(config).unwrap());
        (Arc::new(state), log_path)
    }

    #[tokio::test]
    async fn api_middleware_records_authenticated_actions_without_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let (state, log_path) = test_state(directory.path(), Some("X-Forwarded-Email")).await;
        state.sessions.write().await.insert("session-token-1".to_string());
        *state.password_hash.write().await = Some("configured".to_string());

        // Echo the body so the test proves the handler received it intact.
        let router = Router::new()
            .route("/api/query/execute", post(|body: String| async move { body }))
            .route("/api/query/build-drop-table-sql", post(|| async { "sql" }))
            .route("/api/connection/list", get(|| async { "[]" }))
            .layer(axum::middleware::from_fn_with_state(state.clone(), api_audit_middleware))
            .layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::auth_middleware));
        let (address, server) = serve(router).await;
        let client = reqwest::Client::new();

        let body = serde_json::json!({
            "connectionId": "pg-1", "database": "sales", "sql": "delete from orders", "password": "hunter2"
        });
        let response = client
            .post(format!("http://{address}/api/query/execute"))
            .header("cookie", "dbx_session=session-token-1")
            .header("x-forwarded-email", "alice@example.com")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap(), body);

        // Quiet helper, plain read and an anonymous request: none recorded.
        for request in [
            client
                .post(format!("http://{address}/api/query/build-drop-table-sql"))
                .header("cookie", "dbx_session=session-token-1"),
            client.get(format!("http://{address}/api/connection/list")).header("cookie", "dbx_session=session-token-1"),
            client.post(format!("http://{address}/api/query/execute")).json(&body),
        ] {
            request.send().await.unwrap();
        }

        state.audit.as_ref().unwrap().flush().await;
        let lines = read_lines(&log_path);
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert_eq!(line["channel"], "api");
        assert_eq!(line["action"], "query/execute");
        assert_eq!(line["method"], "POST");
        assert_eq!(line["status"], 200);
        assert_eq!(line["outcome"], "ok");
        assert_eq!(line["peer"], "127.0.0.1");
        assert_eq!(line["user"], "alice@example.com");
        assert_eq!(line["session"], fingerprint("session-token-1"));
        assert_eq!(line["details"]["sql"], "delete from orders");
        assert_eq!(line["details"]["connection_id"], "pg-1");
        let raw = std::fs::read_to_string(&log_path).unwrap();
        assert!(!raw.contains("hunter2") && !raw.contains("session-token-1"), "{raw}");
        server.abort();
    }

    #[tokio::test]
    async fn api_middleware_records_login_outcomes_but_not_anonymous_noise() {
        let directory = tempfile::tempdir().unwrap();
        let (state, log_path) = test_state(directory.path(), None).await;

        let router = Router::new()
            .route(
                "/api/auth/login",
                post(|body: String| async move {
                    match body.as_str() {
                        "good" => (StatusCode::OK, [("set-cookie", "dbx_session=new-token; Path=/; HttpOnly")], "ok")
                            .into_response(),
                        "captcha" => StatusCode::BAD_REQUEST.into_response(),
                        "locked" => StatusCode::TOO_MANY_REQUESTS.into_response(),
                        "no-password" => StatusCode::FORBIDDEN.into_response(),
                        _ => StatusCode::UNAUTHORIZED.into_response(),
                    }
                }),
            )
            // Setup once a password exists: anyone can ask, nobody gets in.
            .route("/api/auth/setup", post(|| async { StatusCode::FORBIDDEN }))
            .layer(axum::middleware::from_fn_with_state(state.clone(), api_audit_middleware));
        let (address, server) = serve(router).await;
        let client = reqwest::Client::new();
        for body in ["good", "wrong", "captcha", "locked", "no-password"] {
            client.post(format!("http://{address}/api/auth/login")).body(body).send().await.unwrap();
        }
        client.post(format!("http://{address}/api/auth/setup")).body("x").send().await.unwrap();

        state.audit.as_ref().unwrap().flush().await;
        let lines = read_lines(&log_path);
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0]["action"], "auth/login");
        assert_eq!(lines[0]["outcome"], "ok");
        assert_eq!(lines[0]["session"], fingerprint("new-token"));
        assert_eq!(lines[1]["outcome"], "denied");
        assert!(lines[1].get("session").is_none());
        assert!(!std::fs::read_to_string(&log_path).unwrap().contains("new-token"));
        server.abort();
    }

    #[tokio::test]
    async fn mcp_middleware_records_tool_calls_and_drops_anonymous_requests() {
        let directory = tempfile::tempdir().unwrap();
        let (state, log_path) = test_state(directory.path(), None).await;
        state.web_mcp.auth().reconfigure(Some("mcp-secret".to_string()), Vec::new(), Vec::new()).unwrap();

        // Stand-in for the MCP router: like the real one, it rejects a bad
        // Origin with 403 before looking at the token.
        let router = Router::new()
            .route(
                "/mcp",
                post(|headers: HeaderMap| async move {
                    if headers.contains_key("origin") {
                        StatusCode::FORBIDDEN
                    } else if headers.get(AUTHORIZATION).is_some_and(|value| *value == "Bearer mcp-secret") {
                        StatusCode::OK
                    } else {
                        StatusCode::UNAUTHORIZED
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(state.clone(), mcp_audit_middleware));
        let (address, server) = serve(router).await;
        let client = reqwest::Client::new();
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "execute_query", "arguments": {"connection_id": "pg-1", "sql": "select 2", "password": "x"}}
        });
        let ping = serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "ping"});
        client.post(format!("http://{address}/mcp")).bearer_auth("mcp-secret").json(&call).send().await.unwrap();
        client.post(format!("http://{address}/mcp")).bearer_auth("mcp-secret").json(&ping).send().await.unwrap();
        // Anonymous: no token, a wrong token, and a 403 produced before auth.
        client.post(format!("http://{address}/mcp")).json(&call).send().await.unwrap();
        client.post(format!("http://{address}/mcp")).bearer_auth("guess").json(&call).send().await.unwrap();
        client
            .post(format!("http://{address}/mcp"))
            .header("origin", "https://evil.example")
            .bearer_auth("guess")
            .json(&call)
            .send()
            .await
            .unwrap();

        state.audit.as_ref().unwrap().flush().await;
        let lines = read_lines(&log_path);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0]["channel"], "mcp");
        assert_eq!(lines[0]["action"], "mcp/tools/call");
        assert_eq!(lines[0]["details"]["tool"], "execute_query");
        assert_eq!(lines[0]["details"]["sql"], "select 2");
        assert_eq!(lines[0]["session"], format!("mcp:{}", fingerprint("mcp-secret")));
        assert!(!std::fs::read_to_string(&log_path).unwrap().contains("mcp-secret"));
        server.abort();
    }
}
