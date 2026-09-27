//! Salesforce (SOQL) driver.
//!
//! Talks to the Salesforce REST API over HTTPS. The connection's `host` field
//! carries the org instance URL (e.g. `https://acme.my.salesforce.com`) and the
//! `password` field carries the OAuth access token / session id.
//!
//! Mapping to DBX abstractions (see docs/salesforce-soql-integration-spec.md):
//! - org            -> single database (`singleDatabase` trait)
//! - sObject        -> table
//! - field          -> column (label + apiName + type + picklist values)
//! - SOQL query     -> `QueryResult` (rows/columns), pagination via QueryLocator
//!
//! DML and SOQL completion metadata are layered on top in later milestones.
//! OAuth lives in `crate::salesforce_oauth`; this module consumes it for
//! transparent token refresh — every request funnels through `api_send` /
//! `api_get_conditional`, both of which retry once after a refresh on 401.

use reqwest::{Client as HttpClient, Method, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{http_client_builder, json_value_for_js, with_connection_timeout};
use crate::db::ColumnInfo;
use crate::salesforce_oauth::{
    oauth_params_from_external_config, password_grant_token, refresh_access_token, SfOauthParams, SfRefreshMethod,
};
use crate::types::QueryResult;

/// API version pinned by default. Salesforce keeps every version alive for
/// 3+ years; bump deliberately (spec §4.1), users can override via
/// `external_config.apiVersion`.
pub const SALESFORCE_DEFAULT_API_VERSION: &str = "v62.0";

/// Hard cap on rows materialized per query batch. Salesforce itself pages
/// SOQL results at 2000 rows and hands out a QueryLocator for the rest.
const SALESFORCE_MAX_ROWS_PER_BATCH: usize = 2_000;

/// Cells larger than this are shipped as a JSON string instead of being
/// flattened, to keep the grid payload bounded (subqueries, rich text, ...).
const SALESFORCE_MAX_NESTED_JSON_CHARS: usize = 64 * 1024;

#[derive(Clone)]
pub struct SfClient {
    http: HttpClient,
    /// Normalized org instance base URL, no trailing slash.
    instance_url: String,
    /// Live access token. Mutable because it is transparently replaced by the
    /// refresh flow (spec §2.4); readers clone it under the lock, never hold
    /// the guard across an await.
    access_token: Arc<Mutex<String>>,
    /// Refresh context parsed from `external_config.auth` (OAuth connections
    /// only). `None` for pasted-token connections.
    refresh: Arc<tokio::sync::Mutex<Option<SfRefreshContext>>>,
    /// e.g. `v62.0` (no leading path component).
    api_version: String,
    timeout: Duration,
    /// `/sobjects/` listing, cached with its ETag (Salesforce supports
    /// conditional requests here; spec §6.1 — quota friendly).
    sobject_cache: Arc<Mutex<Option<CachedSObjectList>>>,
    /// Per-sObject describe bodies, cached in memory for the connection's
    /// lifetime. Describes are large and rarely change within a session.
    describe_cache: Arc<Mutex<HashMap<String, Value>>>,
    /// Resolved organization display name (one SOQL call, cached; falls back
    /// to the instance host label without caching on failure).
    org_name_cache: Arc<Mutex<Option<String>>>,
    /// Cached connected-user identity (one `current_user()` call, cached for
    /// the connection's lifetime so repeated metadata requests don't burn API
    /// quota).
    current_user_cache: Arc<Mutex<Option<SfUserInfo>>>,
}

/// Re-auth material held for the connection's lifetime (refresh token for
/// OAuth connections, stored credentials for username-password connections).
struct SfRefreshContext {
    params: SfOauthParams,
    method: SfRefreshMethod,
}

/// Distinguishes 401s (retryable via refresh) from everything else so the two
/// HTTP surfaces share one retry policy.
enum ApiFailure {
    Unauthorized(String),
    Other(String),
}

impl ApiFailure {
    fn into_error(self) -> String {
        match self {
            Self::Unauthorized(message) | Self::Other(message) => message,
        }
    }
}

impl std::fmt::Debug for SfClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let refresh_configured = self.refresh.try_lock().map(|guard| guard.is_some()).unwrap_or(true);
        f.debug_struct("SfClient")
            .field("instance_url", &self.instance_url)
            .field("api_version", &self.api_version)
            .field("access_token", &"<redacted>")
            .field("refresh_configured", &refresh_configured)
            .finish()
    }
}

struct CachedSObjectList {
    etag: Option<String>,
    entries: Vec<SfSObjectEntry>,
}

/// One entry of the `/sobjects/` listing.
#[derive(Debug, Clone, Serialize)]
pub struct SfSObjectEntry {
    pub name: String,
    pub label: String,
    pub custom: bool,
    pub queryable: bool,
}

/// Identity + coarse admin flag for the connected user (spec §3).
#[derive(Debug, Clone, Serialize, Default)]
pub struct SfUserInfo {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub organization_id: String,
    pub username: String,
    pub profile_name: Option<String>,
    /// `Profile.PermissionsModifyAllData` — advisory only, NOT a security
    /// boundary (server-side sharing/FLS always wins).
    pub is_admin: Option<bool>,
}

impl SfClient {
    /// Build a client from the stored connection config.
    ///
    /// - `instance_url`: org instance (`host` field of the connection; scheme
    ///   defaults to https when missing).
    /// - `access_token`: OAuth access token / session id (`password` field).
    ///   May be empty when `external_config.auth` carries a refresh token —
    ///   the first request then refreshes before hitting the API.
    /// - `external_config`: optional overrides —
    ///   `{ "apiVersion": "v62.0", "auth": { "environment", "loginUrl",
    ///   "clientId", "clientSecret", "refreshToken" } }`. The auth values are
    ///   hydrated from the secret store by dbx-core for saved connections.
    pub fn from_config(
        instance_url: &str,
        access_token: Option<&str>,
        external_config: Option<&Value>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let instance_url = normalize_instance_url(instance_url)?;
        let access_token = access_token.unwrap_or("").trim().to_string();
        let refresh_context = oauth_params_from_external_config(external_config)
            .map(|(params, method)| SfRefreshContext { params, method });
        if access_token.is_empty() && refresh_context.is_none() {
            return Err("Salesforce access token is required. Paste a session/access token, or sign in via OAuth (desktop app).".to_string());
        }
        let api_version = salesforce_api_version(external_config)?;
        let http = http_client_builder(timeout)
            .build()
            .map_err(|error| format!("Failed to initialize Salesforce HTTP client: {error}"))?;
        Ok(Self {
            http,
            instance_url,
            access_token: Arc::new(Mutex::new(access_token)),
            refresh: Arc::new(tokio::sync::Mutex::new(refresh_context)),
            api_version,
            timeout,
            sobject_cache: Arc::new(Mutex::new(None)),
            describe_cache: Arc::new(Mutex::new(HashMap::new())),
            org_name_cache: Arc::new(Mutex::new(None)),
            current_user_cache: Arc::new(Mutex::new(None)),
        })
    }

    /// Whether this client can transparently refresh its access token.
    pub fn has_refresh_token(&self) -> bool {
        self.refresh.try_lock().map(|guard| guard.is_some()).unwrap_or(true)
    }

    fn current_token(&self) -> String {
        self.access_token.lock().map(|token| token.clone()).unwrap_or_default()
    }

    /// Re-authenticate in place (refresh-token exchange, or replaying the
    /// username-password login for ROPC connections). Returns true when a
    /// fresh token was installed; serialized by the async mutex so concurrent
    /// 401s trigger a single re-auth.
    async fn try_refresh_token(&self) -> bool {
        let mut guard = self.refresh.lock().await;
        let Some(context) = guard.as_mut() else { return false };
        let outcome = match &context.method {
            SfRefreshMethod::RefreshToken(refresh_token) => refresh_access_token(&context.params, refresh_token)
                .await
                .map(|tokens| (tokens.access_token, tokens.refresh_token)),
            SfRefreshMethod::Password { username, password } => {
                password_grant_token(&context.params, username, password)
                    .await
                    .map(|tokens| (tokens.access_token, None))
            }
        };
        match outcome {
            Ok((access_token, rotated)) => {
                if let (Some(rotated), SfRefreshMethod::RefreshToken(current)) = (rotated, &mut context.method) {
                    *current = rotated;
                }
                if let Ok(mut current) = self.access_token.lock() {
                    *current = access_token;
                }
                true
            }
            Err(_) => false,
        }
    }

    /// Run one HTTP surface with a single refresh retry: when the first
    /// attempt fails with 401 and a refresh token is configured, refresh and
    /// replay once.
    async fn with_refresh_retry<T, F, Fut>(&self, attempt: F) -> Result<T, String>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T, ApiFailure>>,
    {
        // No token yet (expired paste cleared, or OAuth connection whose
        // access token was never persisted): refresh proactively.
        if self.current_token().is_empty() && self.has_refresh_token() {
            let _ = self.try_refresh_token().await;
        }
        match attempt().await {
            Ok(value) => Ok(value),
            Err(ApiFailure::Unauthorized(message)) => {
                if self.try_refresh_token().await {
                    match attempt().await {
                        Ok(value) => Ok(value),
                        Err(failure) => Err(failure.into_error()),
                    }
                } else {
                    Err(message)
                }
            }
            Err(failure) => Err(failure.into_error()),
        }
    }

    pub fn instance_url(&self) -> &str {
        &self.instance_url
    }

    pub fn api_version(&self) -> &str {
        &self.api_version
    }

    /// `{instance}/services/data/{apiVersion}`
    fn api_base(&self) -> String {
        format!("{}/services/data/{}", self.instance_url, self.api_version)
    }

    async fn api_send(&self, method: Method, url: &str, body: Option<Value>) -> Result<Value, String> {
        let method = method.clone();
        let url = url.to_string();
        self.with_refresh_retry(|| {
            let method = method.clone();
            let url = url.clone();
            let body = body.clone();
            async move { self.api_send_once(method, &url, body).await }
        })
        .await
    }

    async fn api_send_once(&self, method: Method, url: &str, body: Option<Value>) -> Result<Value, ApiFailure> {
        let label = format!("Salesforce {} {}", method, url);
        let request =
            self.http.request(method, url).bearer_auth(self.current_token()).header("Accept", "application/json");
        let request = match body {
            Some(value) => request.json(&value),
            None => request,
        };
        let response = with_connection_timeout(&label, self.timeout, async {
            request.send().await.map_err(|error| format!("Salesforce request failed: {error}"))
        })
        .await
        .map_err(ApiFailure::Other)?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| ApiFailure::Other(format!("Failed to read Salesforce response: {error}")))?;
        if status == StatusCode::UNAUTHORIZED {
            return Err(ApiFailure::Unauthorized(map_salesforce_error(status, &text)));
        }
        if status == StatusCode::NO_CONTENT || text.trim().is_empty() {
            if status.is_success() {
                return Ok(Value::Null);
            }
            return Err(ApiFailure::Other(map_salesforce_error(status, "")));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| ApiFailure::Other(format!("Invalid Salesforce JSON response ({status}): {error}")))?;
        if status.is_success() {
            return Ok(value);
        }
        Err(ApiFailure::Other(salesforce_error_message(status, &value)))
    }

    async fn api_get(&self, url: &str) -> Result<Value, String> {
        self.api_send(Method::GET, url, None).await
    }

    async fn api_post(&self, url: &str, body: Value) -> Result<Value, String> {
        self.api_send(Method::POST, url, Some(body)).await
    }

    async fn api_patch(&self, url: &str, body: Value) -> Result<Value, String> {
        self.api_send(Method::PATCH, url, Some(body)).await
    }

    async fn api_delete(&self, url: &str) -> Result<Value, String> {
        self.api_send(Method::DELETE, url, None).await
    }

    /// GET with conditional-request headers; returns `Ok(None)` on 304.
    async fn api_get_conditional(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<Option<(Value, Option<String>)>, String> {
        let url = url.to_string();
        let etag = etag.map(str::to_string);
        self.with_refresh_retry(|| {
            let url = url.clone();
            let etag = etag.clone();
            async move { self.api_get_conditional_once(&url, etag.as_deref()).await }
        })
        .await
    }

    async fn api_get_conditional_once(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<Option<(Value, Option<String>)>, ApiFailure> {
        let label = format!("Salesforce GET {url}");
        let mut request = self.http.get(url).bearer_auth(self.current_token()).header("Accept", "application/json");
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let response = with_connection_timeout(&label, self.timeout, async {
            request.send().await.map_err(|error| format!("Salesforce request failed: {error}"))
        })
        .await
        .map_err(ApiFailure::Other)?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            let text = response.text().await.unwrap_or_default();
            return Err(ApiFailure::Unauthorized(map_salesforce_error(status, &text)));
        }
        if status == StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        let new_etag =
            response.headers().get(reqwest::header::ETAG).and_then(|value| value.to_str().ok()).map(str::to_string);
        let text = response
            .text()
            .await
            .map_err(|error| ApiFailure::Other(format!("Failed to read Salesforce response: {error}")))?;
        if !status.is_success() {
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            return Err(ApiFailure::Other(salesforce_error_message(status, &value)));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| ApiFailure::Other(format!("Invalid Salesforce JSON response ({status}): {error}")))?;
        Ok(Some((value, new_etag)))
    }

    /// Connectivity/auth check: list API versions (cheap, unauthenticated-ish
    /// endpoint that still surfaces instance URL problems, then hit userinfo
    /// so an expired token fails fast with a clear message).
    pub async fn test_connection(client: &SfClient, timeout: Duration) -> Result<(), String> {
        let label = "Salesforce connectivity check";
        let versions_url = format!("{}/services/data", client.instance_url);
        let versions = with_connection_timeout(label, timeout, async {
            client
                .http
                .get(&versions_url)
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|error| format!("Cannot reach Salesforce instance '{versions_url}': {error}"))
        })
        .await?;
        let status = versions.status();
        if !status.is_success() {
            return Err(format!("Salesforce instance returned HTTP {status} for {versions_url}"));
        }
        // Validate the token itself.
        client.api_get(&format!("{}/sobjects/", client.api_base())).await.map(|_| ())
    }

    /// Execute a SOQL query or a `DBX SALESFORCE DML` pseudo-command. `max_rows`
    /// caps materialized rows; remaining rows stay behind `has_more` +
    /// QueryLocator (`session_id`).
    pub async fn execute_query(&self, soql: &str, max_rows: Option<usize>) -> Result<QueryResult, String> {
        // Route DBX SALESFORCE pseudo-commands before the SOQL path so they
        // never get `apply_fields_function_limit` treatment.
        if starts_with_salesforce_header(soql) {
            let statement = parse_salesforce_statement(soql)?;
            return self.execute_dml(&statement).await;
        }
        let started = Instant::now();
        let soql = apply_fields_function_limit(soql);
        let url = format!("{}/query?q={}", self.api_base(), urlencoded(&soql));
        let value = self.api_get(&url).await?;
        let limit = max_rows.unwrap_or(SALESFORCE_MAX_ROWS_PER_BATCH).max(1);
        Ok(parse_soql_response(value, started.elapsed().as_millis(), limit))
    }

    /// Fetch the next page using a QueryLocator URL returned as `session_id`.
    pub async fn fetch_more(&self, cursor: &str) -> Result<QueryResult, String> {
        let started = Instant::now();
        let url = self.resolve_cursor_url(cursor)?;
        let value = self.api_get(&url).await?;
        Ok(parse_soql_response(value, started.elapsed().as_millis(), SALESFORCE_MAX_ROWS_PER_BATCH))
    }

    /// Resolve a QueryLocator cursor to a request URL. Salesforce returns
    /// `nextRecordsUrl` as an absolute URL on the org's own host; relative
    /// cursors are resolved against the instance. An absolute cursor pointing
    /// at any other origin would receive this connection's bearer token, so it
    /// is refused instead of followed.
    fn resolve_cursor_url(&self, cursor: &str) -> Result<String, String> {
        let trimmed = cursor.trim();
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            return Ok(format!("{}{}", self.instance_url, trimmed));
        }
        let instance =
            Url::parse(&self.instance_url).map_err(|error| format!("Salesforce instance URL is invalid: {error}"))?;
        let absolute =
            Url::parse(trimmed).map_err(|error| format!("Salesforce query cursor is not a valid URL: {error}"))?;
        if absolute.origin() != instance.origin() {
            return Err(format!(
                "Salesforce query cursor points outside the connected org ({}) and was not followed",
                absolute.host_str().unwrap_or_default()
            ));
        }
        Ok(trimmed.to_string())
    }

    /// sObject listing (queryable ones are the "tables" of the org).
    pub async fn list_sobjects(&self) -> Result<Vec<SfSObjectEntry>, String> {
        let url = format!("{}/sobjects/", self.api_base());
        let cached_etag =
            self.sobject_cache.lock().ok().and_then(|guard| guard.as_ref().and_then(|cached| cached.etag.clone()));
        match self.api_get_conditional(&url, cached_etag.as_deref()).await? {
            None => {
                // 304 — serve from cache.
                let entries = self
                    .sobject_cache
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().map(|cached| cached.entries.clone()))
                    .unwrap_or_default();
                Ok(entries)
            }
            Some((value, etag)) => {
                let entries = parse_sobject_list(&value);
                if let Ok(mut guard) = self.sobject_cache.lock() {
                    *guard = Some(CachedSObjectList { etag, entries: entries.clone() });
                }
                Ok(entries)
            }
        }
    }

    /// Table names for the schema browser / completion metadata.
    pub async fn list_tables(&self) -> Result<Vec<String>, String> {
        Ok(self.list_sobjects().await?.into_iter().filter(|entry| entry.queryable).map(|entry| entry.name).collect())
    }

    /// Raw describe body for one sObject (cached per connection).
    pub async fn describe_sobject(&self, name: &str) -> Result<Value, String> {
        if let Some(cached) = self.describe_cache.lock().ok().and_then(|guard| guard.get(name).cloned()) {
            return Ok(cached);
        }
        let url = format!("{}/sobjects/{}/describe", self.api_base(), urlencoded(name));
        let value = self.api_get(&url).await?;
        if let Ok(mut guard) = self.describe_cache.lock() {
            guard.insert(name.to_string(), value.clone());
        }
        Ok(value)
    }

    /// Field metadata for one sObject, mapped onto `ColumnInfo`
    /// (label → comment, picklist values → enum_values, Id → primary key).
    pub async fn get_columns(&self, sobject: &str) -> Result<Vec<ColumnInfo>, String> {
        let describe = self.describe_sobject(sobject).await?;
        Ok(parse_describe_columns(&describe))
    }

    /// Connected-user identity + coarse admin flag (spec §3).
    pub async fn current_user(&self) -> Result<SfUserInfo, String> {
        let userinfo = self.api_get(&format!("{}/services/oauth2/userinfo", self.instance_url)).await?;
        let mut info = SfUserInfo {
            user_id: string_field(&userinfo, "user_id"),
            name: string_field(&userinfo, "name"),
            email: string_field(&userinfo, "email"),
            organization_id: string_field(&userinfo, "organization_id"),
            ..Default::default()
        };
        // Coarse admin detection via Profile permission flags. The user id from
        // userinfo is a 15/18-char alphanumeric Salesforce id; refuse anything
        // else instead of interpolating it into SOQL.
        if !info.user_id.is_empty() && info.user_id.chars().all(|c| c.is_ascii_alphanumeric()) {
            let soql = format!(
                "SELECT Username, Profile.Name, Profile.PermissionsModifyAllData FROM User WHERE Id = '{}'",
                info.user_id
            );
            let url = format!("{}/query?q={}", self.api_base(), urlencoded(&soql));
            if let Ok(value) = self.api_get(&url).await {
                if let Some(record) = value.get("records").and_then(Value::as_array).and_then(|rows| rows.first()) {
                    info.username = string_field(record, "Username");
                    info.profile_name =
                        record.get("Profile").and_then(|p| p.get("Name")).and_then(Value::as_str).map(str::to_string);
                    info.is_admin =
                        record.get("Profile").and_then(|p| p.get("PermissionsModifyAllData")).and_then(Value::as_bool);
                }
            }
        }
        Ok(info)
    }

    /// Cached variant of `current_user()`: returns the resolved identity from
    /// the in-memory cache when available, falling back to a fresh call on
    /// the first invocation (or after the cache is cleared). Repeated UI
    /// polls don't burn Salesforce API quota.
    pub async fn cached_current_user(&self) -> Result<SfUserInfo, String> {
        if let Some(cached) = self.current_user_cache.lock().ok().and_then(|guard| guard.clone()) {
            return Ok(cached);
        }
        let info = self.current_user().await?;
        if let Ok(mut guard) = self.current_user_cache.lock() {
            *guard = Some(info.clone());
        }
        Ok(info)
    }

    /// Display name of the org for the synthesized single database node
    /// (`singleDatabase` trait). One cached `SELECT Name FROM Organization`;
    /// falls back to the instance host's first label (e.g. `acme--qas1`)
    /// when that query is unavailable. Fallbacks are NOT cached so a transient
    /// failure does not stick.
    pub async fn org_display_name(&self) -> String {
        if let Some(name) = self.org_name_cache.lock().ok().and_then(|guard| guard.clone()) {
            return name;
        }
        let url = format!("{}/query?q={}", self.api_base(), urlencoded("SELECT Name FROM Organization LIMIT 1"));
        if let Ok(value) = self.api_get(&url).await {
            let name =
                value.pointer("/records/0/Name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty());
            if let Some(name) = name {
                if let Ok(mut guard) = self.org_name_cache.lock() {
                    *guard = Some(name.to_string());
                }
                return name.to_string();
            }
        }
        self.instance_host_fallback_name()
    }

    fn instance_host_fallback_name(&self) -> String {
        let host = self.instance_url.split_once("://").map(|(_, rest)| rest).unwrap_or(self.instance_url.as_str());
        let label = host.split(['/', ':']).next().unwrap_or("");
        label.split('.').next().filter(|part| !part.is_empty()).unwrap_or("Salesforce").to_string()
    }
}

fn normalize_instance_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Salesforce instance URL is required (e.g. https://acme.my.salesforce.com).".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    if trimmed.contains("://") {
        return Err(format!("Unsupported Salesforce instance URL scheme: {trimmed}"));
    }
    Ok(format!("https://{trimmed}"))
}

fn salesforce_api_version(external_config: Option<&Value>) -> Result<String, String> {
    let raw = external_config
        .and_then(|config| config.get("apiVersion"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(SALESFORCE_DEFAULT_API_VERSION);
    let normalized = if let Some(stripped) = raw.strip_prefix('v') { stripped } else { raw };
    if normalized.is_empty()
        || !normalized.split_once('.').is_some_and(|(major, minor)| {
            !major.is_empty() && major.chars().all(|c| c.is_ascii_digit()) && !minor.is_empty()
        })
    {
        return Err(format!("Invalid Salesforce API version '{raw}' (expected e.g. v62.0)."));
    }
    Ok(format!("v{normalized}"))
}

fn urlencoded(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn string_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Largest `&s[..n]` that ends on a UTF-8 char boundary (`str::floor_char_boundary`
/// is still unstable).
fn truncate_at_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Parse a `/query` (or QueryLocator page) response into a `QueryResult`.
///
/// Column layout: record keys in first-seen order, minus `attributes`.
/// Nested objects (compound fields like `BillingAddress`) are flattened one
/// level with dotted names; anything deeper (relationship subqueries, arrays)
/// is serialized to a JSON string cell so the grid stays tabular.
fn parse_soql_response(value: Value, elapsed_ms: u128, max_rows: usize) -> QueryResult {
    let mut columns: Vec<String> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;

    let records = value.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
    let total_size = value.get("totalSize").and_then(Value::as_u64).unwrap_or(records.len() as u64);

    for record in records.iter() {
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let mut cells: Vec<(String, Value)> = Vec::new();
        flatten_record(record, "", &mut cells, 0);
        let mut row: Vec<Value> = vec![Value::Null; columns.len()];
        for (key, cell) in cells {
            let index = match seen.get(&key) {
                Some(index) => *index,
                None => {
                    let index = columns.len();
                    columns.push(key.clone());
                    seen.insert(key.clone(), index);
                    row.push(Value::Null);
                    index
                }
            };
            row[index] = json_value_for_js(cell);
        }
        rows.push(row);
    }

    let column_types = infer_column_types(&columns, &rows);
    let done = value.get("done").and_then(Value::as_bool).unwrap_or(true);
    let next_url = value.get("nextRecordsUrl").and_then(Value::as_str).map(str::to_string).filter(|_| !done);

    QueryResult {
        columns,
        column_types,
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows,
        affected_rows: total_size,
        execution_time_ms: elapsed_ms,
        server_execute_time_us: None,
        query_timings_ms: None,
        truncated,
        session_id: next_url,
        has_more: !done || truncated,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn flatten_record(value: &Value, prefix: &str, out: &mut Vec<(String, Value)>, depth: u8) {
    let Some(map) = value.as_object() else {
        out.push((prefix.to_string(), value.clone()));
        return;
    };
    // A nested query locator / subquery result — keep it as a JSON string.
    if map.contains_key("records") || depth >= 2 {
        let encoded = serde_json::to_string(value).unwrap_or_default();
        let cell = if encoded.len() > SALESFORCE_MAX_NESTED_JSON_CHARS {
            let cut = truncate_at_char_boundary(&encoded, SALESFORCE_MAX_NESTED_JSON_CHARS);
            Value::String(format!("{cut}…(truncated)"))
        } else {
            Value::String(encoded)
        };
        out.push((prefix.to_string(), cell));
        return;
    }
    for (key, child) in map {
        if key == "attributes" && prefix.is_empty() {
            continue;
        }
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        match child {
            // Recurse for every object so the rule above decides the shape: a
            // compound field flattens (BillingAddress.city) while a subquery
            // locator — or anything already two levels deep — stays one JSON
            // string cell.
            Value::Object(_) => flatten_record(child, &path, out, depth + 1),
            _ => out.push((path, child.clone())),
        }
    }
}

fn infer_column_types(columns: &[String], rows: &[Vec<Value>]) -> Vec<String> {
    columns
        .iter()
        .enumerate()
        .map(|(index, _)| {
            for row in rows {
                if let Some(cell) = row.get(index) {
                    match cell {
                        Value::Null => continue,
                        Value::Bool(_) => return "boolean".to_string(),
                        Value::Number(_) => return "double".to_string(),
                        Value::String(_) => return "string".to_string(),
                        _ => return "json".to_string(),
                    }
                }
            }
            String::new()
        })
        .collect()
}

fn parse_sobject_list(value: &Value) -> Vec<SfSObjectEntry> {
    value
        .get("sobjects")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let name = string_field(entry, "name");
                    if name.is_empty() {
                        return None;
                    }
                    Some(SfSObjectEntry {
                        label: string_field(entry, "label"),
                        custom: entry.get("custom").and_then(Value::as_bool).unwrap_or(false),
                        queryable: entry.get("queryable").and_then(Value::as_bool).unwrap_or(false),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a describe field entry can be named in a SOQL `SELECT` list.
///
/// Two kinds of describe entry cannot, and Salesforce rejects the *whole* query
/// for either one:
///
/// * Compound `address` / `location` fields (`BillingAddress`, `Location__c`) are
///   metadata containers. SOQL projects their sub-fields instead — `BillingStreet`,
///   `BillingLatitude`, … — which describe already returns as separate entries, so
///   flattening to the sub-fields (spec §7) loses nothing.
/// * Fields the running user has no FLS read access to (`accessible: false`) are
///   invisible to SOQL, which answers `INVALID_FIELD`. `FIELDS(ALL)` skips them for
///   the same reason, so an explicit projection has to match. A missing flag means
///   the org did not report FLS at all: keep the field.
fn is_soql_projectable_field(field: &Value) -> bool {
    let field_type = string_field(field, "type").to_ascii_lowercase();
    if matches!(field_type.as_str(), "address" | "location") {
        return false;
    }
    field.get("accessible").and_then(Value::as_bool).unwrap_or(true)
}

fn parse_describe_columns(describe: &Value) -> Vec<ColumnInfo> {
    describe
        .get("fields")
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
                // This list feeds the data grid's explicit SOQL projection and the
                // editor's field completion, so a name SOQL cannot project must not
                // appear: one bad field fails the whole query rather than one column.
                .filter(|field| is_soql_projectable_field(field))
                .map(|field| {
                    let name = string_field(field, "name");
                    let label = string_field(field, "label");
                    let data_type = string_field(field, "type");
                    let picklist_values = field
                        .get("picklistValues")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter(|value| value.get("active").and_then(Value::as_bool).unwrap_or(true))
                                .map(|value| string_field(value, "value"))
                                .filter(|value| !value.is_empty())
                                .collect::<Vec<_>>()
                        })
                        .filter(|values: &Vec<String>| !values.is_empty());
                    let length = field.get("length").and_then(Value::as_i64).filter(|length| *length > 0);
                    let mut extra = serde_json::json!({
                        "updateable": field.get("updateable").and_then(Value::as_bool).unwrap_or(false),
                        "createable": field.get("createable").and_then(Value::as_bool).unwrap_or(false),
                        "custom": field.get("custom").and_then(Value::as_bool).unwrap_or(false),
                        "label": label,
                    });
                    if let Some(rel_name) = field.get("relationshipName").and_then(Value::as_str) {
                        if !rel_name.is_empty() {
                            extra["relationshipName"] = serde_json::json!(rel_name);
                        }
                    }
                    if let Some(refs) = field.get("referenceTo").and_then(Value::as_array) {
                        let ref_strings: Vec<String> =
                            refs.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(String::from).collect();
                        if !ref_strings.is_empty() {
                            extra["referenceTo"] = serde_json::json!(ref_strings);
                        }
                    }
                    ColumnInfo {
                        is_primary_key: name.eq_ignore_ascii_case("Id"),
                        is_nullable: field.get("nillable").and_then(Value::as_bool).unwrap_or(true),
                        column_default: field.get("defaultValue").filter(|value| !value.is_null()).map(|value| {
                            match value {
                                Value::String(text) => text.clone(),
                                other => other.to_string(),
                            }
                        }),
                        is_unique: false,
                        // describe flags the grid/DML layer needs later (M4):
                        // formula/rollup/auto-number fields come back with
                        // updateable=false and must render read-only.
                        extra: Some(extra.to_string()),
                        comment: if label.is_empty() || label == name { None } else { Some(label) },
                        numeric_precision: field
                            .get("precision")
                            .and_then(Value::as_i64)
                            .and_then(|p| i32::try_from(p).ok())
                            .filter(|p| *p > 0),
                        numeric_scale: field
                            .get("scale")
                            .and_then(Value::as_i64)
                            .and_then(|s| i32::try_from(s).ok())
                            .filter(|s| *s > 0),
                        character_maximum_length: length.and_then(|l| i32::try_from(l).ok()),
                        enum_values: picklist_values,
                        resolved_schema: None,
                        // Plugin-provided column metadata capabilities do not apply:
                        // the describe payload is parsed here, not by a plugin driver.
                        metadata_capabilities: None,
                        character_set: None,
                        collation: None,
                        name,
                        data_type,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// SOQL's `FIELDS(ALL)` / `FIELDS(STANDARD)` / `FIELDS(CUSTOM)` selectors require the
/// query to carry `LIMIT n` with n ≤ 200 (a Salesforce REST rule). Users writing
/// `SELECT FIELDS(ALL) FROM Account` hit `MALFORMED_QUERY` otherwise. When the query
/// uses a FIELDS function and has no LIMIT clause yet, append `LIMIT 200` so the common
/// "select everything" intent just works. If a LIMIT is already present we never touch
/// it (Salesforce's own error explains a too-large limit better than we could).
///
/// Detection is a lightweight case-insensitive scan; it intentionally skips content
/// inside single-quoted string literals so a `WHERE Name = 'LIMIT'` does not suppress
/// the append, and so `FIELDS(ALL)` inside a literal does not trigger it.
fn apply_fields_function_limit(soql: &str) -> std::borrow::Cow<'_, str> {
    fn scan(outside_literals: &str) -> (bool, bool) {
        let upper = outside_literals.to_ascii_uppercase();
        // Compact away whitespace so both `FIELDS(ALL)` and `FIELDS ( ALL )` match.
        let compact: String = upper.chars().filter(|c| !c.is_whitespace()).collect();
        let has_fields = ["FIELDS(ALL)", "FIELDS(STANDARD)", "FIELDS(CUSTOM)"].iter().any(|n| compact.contains(n));
        // Word-boundary LIMIT search on the original (spacing-preserving) masked text.
        let bytes = upper.as_bytes();
        let mut has_limit = false;
        for (i, _) in upper.match_indices("LIMIT") {
            let before_ok = i == 0 || (!bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_');
            let after = i + "LIMIT".len();
            let after_ok = after >= bytes.len() || (!bytes[after].is_ascii_alphanumeric() && bytes[after] != b'_');
            if before_ok && after_ok {
                has_limit = true;
                break;
            }
        }
        (has_fields, has_limit)
    }

    // Build a copy of the query with single-quoted literal bodies blanked out, so the
    // keyword scan ignores them. SOQL escapes a quote inside a literal by backslash.
    let mut masked = String::with_capacity(soql.len());
    let chars: Vec<char> = soql.chars().collect();
    let mut i = 0;
    let mut in_literal = false;
    while i < chars.len() {
        let c = chars[i];
        if in_literal {
            if c == '\\' {
                masked.push(' ');
                if i + 1 < chars.len() {
                    masked.push(' ');
                }
                i += 2;
                continue;
            }
            if c == '\'' {
                in_literal = false;
                masked.push(' ');
            } else {
                masked.push(' ');
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            in_literal = true;
            masked.push(' ');
            i += 1;
            continue;
        }
        masked.push(c);
        i += 1;
    }

    let (has_fields, has_limit) = scan(&masked);
    if !has_fields || has_limit {
        return std::borrow::Cow::Borrowed(soql);
    }
    let trimmed = soql.trim_end_matches(|c: char| c.is_whitespace() || c == ';');
    std::borrow::Cow::Owned(format!("{trimmed} LIMIT 200"))
}

fn map_salesforce_error(status: StatusCode, body: &str) -> String {
    let mut message = format!("Salesforce API error (HTTP {status})");
    if !body.is_empty() {
        message.push_str(": ");
        message.push_str(body);
    }
    message
}

/// Turn a Salesforce REST error body (`[{errorCode, message, fields}]`) into a
/// user-readable message with the common codes explained (spec §7).
fn salesforce_error_message(status: StatusCode, body: &Value) -> String {
    let first = body.as_array().and_then(|entries| entries.first());
    let entry = first.unwrap_or(body);
    let code = entry.get("errorCode").and_then(Value::as_str).unwrap_or("");
    let message = entry.get("message").and_then(Value::as_str).unwrap_or("");
    let hint = match code {
        "INVALID_SESSION_ID" | "INVALID_AUTH_HEADER" => {
            Some("Access token is invalid or expired — reconnect or paste a fresh token.")
        }
        "MALFORMED_QUERY" => {
            if message.contains("FIELDS function must have a LIMIT") {
                Some("FIELDS(ALL/STANDARD/CUSTOM) requires LIMIT 200 or less — lower the explicit LIMIT value (DBX auto-appends LIMIT 200 only when the query has no LIMIT at all).")
            } else {
                Some("SOQL syntax error — check the query near the position Salesforce reports.")
            }
        }
        "INVALID_FIELD" | "INVALID_TYPE" | "INVALID_COLUMN" => {
            Some("Unknown object/field, or it is not visible to your user (field-level security).")
        }
        "INSUFFICIENT_ACCESS" | "INSUFFICIENT_ACCESS_OR_READONLY" => {
            Some("Your Salesforce user lacks access to this operation.")
        }
        "REQUEST_LIMIT_EXCEEDED" | "TOTAL_API_REQUESTS_LIMIT_EXCEEDED" => Some(
            "Salesforce daily API request limit exhausted for this org — this is a Salesforce-side quota, not a DBX limit.",
        ),
        "NOT_MODIFIED" => None,
        _ => None,
    };
    let mut result = if status == StatusCode::UNAUTHORIZED && code.is_empty() {
        "Salesforce authentication failed (HTTP 401): access token is invalid or expired.".to_string()
    } else if code.is_empty() && message.is_empty() {
        map_salesforce_error(status, "")
    } else {
        format!("Salesforce error [{code}]: {message}")
    };
    if let Some(hint) = hint {
        result.push_str("\n\nHint: ");
        result.push_str(hint);
    }
    result
}

// ---------------------------------------------------------------------------
// DBX SALESFORCE DML pseudo-command (spec §8)
// ---------------------------------------------------------------------------

/// Pseudo-command header the grid save path emits. Case-insensitive after
/// trim; everything after it (trimmed) is one JSON object.
const SALESFORCE_DML_HEADER: &str = "DBX SALESFORCE DML";

/// DML operation parsed from the JSON body's `op` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SfDmlOp {
    Insert,
    Update,
    Delete,
}

impl SfDmlOp {
    /// Lowercase wire name, as it appears in the statement's `op` field. Public
    /// so callers that render a statement back to a human (MCP write
    /// confirmations) cannot drift from what the parser accepts.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

/// Parsed `DBX SALESFORCE DML` statement ready for execution.
#[derive(Debug, Clone)]
pub struct SfDmlStatement {
    pub op: SfDmlOp,
    pub object: String,
    /// Required for `update`/`delete`; ignored for `insert`.
    pub id: Option<String>,
    /// Field API name → JSON value. Required and non-empty for `insert`/
    /// `update`; absent for `delete`.
    pub fields: Option<serde_json::Map<String, Value>>,
}

/// True when the source's first non-empty trimmed line begins with
/// `DBX SALESFORCE` (case-insensitive). Used by `execute_query` to route
/// pseudo-commands away from the SOQL path without eagerly parsing the JSON
/// body — a non-DBX SOQL query never reaches this check.
fn starts_with_salesforce_header(source: &str) -> bool {
    let header = source.lines().find(|line| !line.trim().is_empty()).map(str::trim).unwrap_or("");
    header.to_ascii_uppercase().starts_with("DBX SALESFORCE")
}

/// Parse a `DBX SALESFORCE DML` statement from its textual form.
///
/// Shape (header line + JSON body, DynamoDB-precedent):
/// ```text
/// DBX SALESFORCE DML
/// {"op":"update","object":"Account","id":"001xx…","fields":{"Name":"Acme"}}
/// ```
///
/// The header is compared case-insensitively after trim; the remainder is
/// trimmed and parsed as one JSON object. Unknown `DBX SALESFORCE …` headers,
/// malformed JSON, unknown ops, and missing required fields all produce
/// `Err(String)` — never a panic.
pub fn parse_salesforce_statement(source: &str) -> Result<SfDmlStatement, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Salesforce statement is empty.".to_string());
    }
    let (header, rest) = match trimmed.split_once('\n') {
        Some((h, r)) => (h.trim(), r),
        None => (trimmed, ""),
    };
    if !header.eq_ignore_ascii_case(SALESFORCE_DML_HEADER) {
        return Err(
            "Unsupported DBX SALESFORCE statement. Use DBX SALESFORCE DML with a JSON body (op, object, id, fields)."
                .to_string(),
        );
    }
    let body = rest.trim();
    if body.is_empty() {
        return Err("DBX SALESFORCE DML statement is missing its JSON body.".to_string());
    }
    let json: Value =
        serde_json::from_str(body).map_err(|error| format!("Invalid DBX SALESFORCE DML JSON body: {error}"))?;
    let obj = json.as_object().ok_or_else(|| "DBX SALESFORCE DML body must be a JSON object.".to_string())?;

    let op_str = obj
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "DBX SALESFORCE DML body requires an 'op' field (insert | update | delete).".to_string())?;
    let op = match op_str {
        "insert" => SfDmlOp::Insert,
        "update" => SfDmlOp::Update,
        "delete" => SfDmlOp::Delete,
        _ => return Err(format!("Unknown DBX SALESFORCE DML op: '{op_str}'. Expected insert, update, or delete.")),
    };

    let object = obj
        .get("object")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "DBX SALESFORCE DML body requires a non-empty 'object' field.".to_string())?
        .to_string();

    let id = obj.get("id").and_then(Value::as_str).map(str::to_string);

    match op {
        SfDmlOp::Update | SfDmlOp::Delete => {
            if id.as_deref().unwrap_or("").is_empty() {
                return Err(format!("DBX SALESFORCE DML {} requires a non-empty 'id' field.", op.as_str()));
            }
        }
        SfDmlOp::Insert => {}
    }

    let fields = obj.get("fields").and_then(Value::as_object).cloned();
    match op {
        SfDmlOp::Insert | SfDmlOp::Update => {
            if fields.as_ref().is_none_or(|map| map.is_empty()) {
                return Err(format!("DBX SALESFORCE DML {} requires a non-empty 'fields' object.", op.as_str()));
            }
        }
        SfDmlOp::Delete => {}
    }

    Ok(SfDmlStatement { op, object, id, fields })
}

impl SfClient {
    /// Execute a parsed `DBX SALESFORCE DML` statement against the REST API.
    ///
    /// - `insert` → `POST {apiBase}/sobjects/{object}` (body = fields)
    /// - `update` → `PATCH {apiBase}/sobjects/{object}/{id}` (body = fields)
    /// - `delete` → `DELETE {apiBase}/sobjects/{object}/{id}` (no body)
    ///
    /// Insert returns the new Id in the result rows; update/delete return
    /// `affected_rows = 1` with no rows. Errors are prefixed with the
    /// operation context so a failed row is identifiable in a batch.
    async fn execute_dml(&self, statement: &SfDmlStatement) -> Result<QueryResult, String> {
        let started = Instant::now();
        let api_base = self.api_base();
        let context = match statement.op {
            SfDmlOp::Insert => format!("insert on {}", statement.object),
            SfDmlOp::Update => format!("update on {} (Id {})", statement.object, statement.id.as_deref().unwrap_or("")),
            SfDmlOp::Delete => format!("delete on {} (Id {})", statement.object, statement.id.as_deref().unwrap_or("")),
        };

        match statement.op {
            SfDmlOp::Insert => {
                let url = format!("{api_base}/sobjects/{}", urlencoded(&statement.object));
                let body = Value::Object(statement.fields.clone().unwrap_or_default());
                let value =
                    self.api_post(&url, body).await.map_err(|error| format!("Salesforce {context} failed: {error}"))?;
                let success = value.get("success").and_then(Value::as_bool).unwrap_or(false);
                if !success {
                    let errors = value.get("errors").cloned().unwrap_or(Value::Null);
                    let detail = if errors.is_null() {
                        "Salesforce reported success=false without error details.".to_string()
                    } else {
                        format!("{errors}")
                    };
                    return Err(format!("Salesforce {context} failed: {detail}"));
                }
                let new_id = value.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                Ok(QueryResult {
                    columns: vec!["Id".to_string()],
                    column_types: vec!["String".to_string()],
                    column_sortables: vec![false],
                    spatial_columns: Vec::new(),
                    spatial_values: Vec::new(),
                    rows: vec![vec![Value::String(new_id)]],
                    affected_rows: 1,
                    execution_time_ms: started.elapsed().as_millis(),
                    server_execute_time_us: None,
                    query_timings_ms: None,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                    elasticsearch_raw_body: None,
                    messages: Vec::new(),
                })
            }
            SfDmlOp::Update => {
                let id = statement.id.as_deref().unwrap_or("");
                let url = format!("{api_base}/sobjects/{}/{}", urlencoded(&statement.object), urlencoded(id));
                let body = Value::Object(statement.fields.clone().unwrap_or_default());
                self.api_patch(&url, body).await.map_err(|error| format!("Salesforce {context} failed: {error}"))?;
                Ok(salesforce_affected_query_result(1, started))
            }
            SfDmlOp::Delete => {
                let id = statement.id.as_deref().unwrap_or("");
                let url = format!("{api_base}/sobjects/{}/{}", urlencoded(&statement.object), urlencoded(id));
                self.api_delete(&url).await.map_err(|error| format!("Salesforce {context} failed: {error}"))?;
                Ok(salesforce_affected_query_result(1, started))
            }
        }
    }
}

fn salesforce_affected_query_result(affected_rows: u64, started: Instant) -> QueryResult {
    QueryResult {
        columns: Vec::new(),
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows: Vec::new(),
        affected_rows,
        execution_time_ms: started.elapsed().as_millis(),
        server_execute_time_us: None,
        query_timings_ms: None,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_instance_url_defaults_to_https_and_strips_slash() {
        assert_eq!(normalize_instance_url("acme.my.salesforce.com/").unwrap(), "https://acme.my.salesforce.com");
        assert_eq!(normalize_instance_url("https://login.salesforce.com").unwrap(), "https://login.salesforce.com");
        assert!(normalize_instance_url("ftp://x").is_err());
        assert!(normalize_instance_url("  ").is_err());
    }

    #[test]
    fn org_name_fallback_uses_first_host_label() {
        let client = SfClient::from_config(
            "https://acme--qas1.sandbox.my.salesforce.com",
            Some("tok"),
            None,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(client.instance_host_fallback_name(), "acme--qas1");
        let plain = SfClient::from_config("na1.salesforce.com", Some("tok"), None, Duration::from_secs(5)).unwrap();
        assert_eq!(plain.instance_host_fallback_name(), "na1");
    }

    #[test]
    fn api_version_validation() {
        assert_eq!(salesforce_api_version(None).unwrap(), SALESFORCE_DEFAULT_API_VERSION);
        let config = serde_json::json!({ "apiVersion": "61.0" });
        assert_eq!(salesforce_api_version(Some(&config)).unwrap(), "v61.0");
        let bad = serde_json::json!({ "apiVersion": "abc" });
        assert!(salesforce_api_version(Some(&bad)).is_err());
    }

    #[test]
    fn parse_soql_response_maps_rows_and_pagination() {
        let body = serde_json::json!({
            "totalSize": 3,
            "done": false,
            "nextRecordsUrl": "/services/data/v62.0/query/01gxx00000-2000",
            "records": [
                {"attributes": {"type": "Account"}, "Id": "001x1", "Name": "Acme", "BillingAddress": {"city": "SF", "street": "Market St"}},
                {"attributes": {"type": "Account"}, "Id": "001x2", "Name": "Globex", "AnnualRevenue": 12345.67}
            ]
        });
        let result = parse_soql_response(body, 12, SALESFORCE_MAX_ROWS_PER_BATCH);
        assert_eq!(result.columns, vec!["Id", "Name", "BillingAddress.city", "BillingAddress.street", "AnnualRevenue"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][2], serde_json::json!("SF"));
        assert_eq!(result.rows[1][4], serde_json::json!(12345.67));
        assert!(result.has_more);
        assert_eq!(result.session_id.as_deref(), Some("/services/data/v62.0/query/01gxx00000-2000"));
        assert_eq!(result.column_types[4], "double");
        assert!(!result.truncated);
    }

    #[test]
    fn parse_soql_response_truncates_at_max_rows() {
        let records: Vec<Value> = (0..5).map(|i| serde_json::json!({"Id": format!("001{i}")})).collect();
        let body = serde_json::json!({ "totalSize": 5, "done": true, "records": records });
        let result = parse_soql_response(body, 1, 3);
        assert_eq!(result.rows.len(), 3);
        assert!(result.truncated);
        assert!(result.has_more);
    }

    #[test]
    fn parse_soql_response_keeps_subqueries_as_json_strings() {
        let body = serde_json::json!({
            "totalSize": 1,
            "done": true,
            "records": [{
                "attributes": {"type": "Account"},
                "Id": "001x1",
                "Contacts": {"totalSize": 1, "done": true, "records": [{"Id": "003x1", "Name": "Ann"}]}
            }]
        });
        let result = parse_soql_response(body, 1, 100);
        assert_eq!(result.columns, vec!["Id", "Contacts"]);
        let cell = result.rows[0][1].as_str().unwrap();
        assert!(cell.contains("003x1"));
    }

    #[test]
    fn describe_columns_map_picklists_and_flags() {
        let describe = serde_json::json!({
            "fields": [
                {"name": "Id", "label": "Record ID", "type": "id", "nillable": false, "updateable": false, "createable": false, "length": 18},
                {"name": "StageName", "label": "Stage", "type": "picklist", "nillable": false, "updateable": true, "createable": true,
                 "picklistValues": [{"value": "Prospecting", "active": true}, {"value": "Closed", "active": true}, {"value": "Old", "active": false}]},
                {"name": "Amount", "label": "Amount", "type": "currency", "nillable": true, "updateable": true, "createable": true, "precision": 18, "scale": 2}
            ]
        });
        let columns = parse_describe_columns(&describe);
        assert_eq!(columns.len(), 3);
        assert!(columns[0].is_primary_key);
        assert_eq!(columns[1].enum_values.as_ref().unwrap(), &vec!["Prospecting".to_string(), "Closed".to_string()]);
        assert_eq!(columns[1].comment.as_deref(), Some("Stage"));
        assert_eq!(columns[2].numeric_precision, Some(18));
        assert_eq!(columns[2].numeric_scale, Some(2));
        let extra: Value = serde_json::from_str(columns[1].extra.as_ref().unwrap()).unwrap();
        assert_eq!(extra["updateable"], serde_json::json!(true));
    }

    #[test]
    fn describe_columns_omit_fields_soql_cannot_project() {
        // The grid projects describe fields by name, and SOQL fails the whole query
        // on a field it cannot select. Compound address/location fields and
        // FLS-hidden fields are both invisible to a SELECT list; their sub-fields
        // (`BillingStreet`, …) arrive as separate describe entries and are kept.
        let describe = serde_json::json!({
            "fields": [
                {"name": "Id", "type": "id", "accessible": true},
                {"name": "BillingAddress", "type": "address", "accessible": true},
                {"name": "BillingStreet", "type": "textarea", "compoundFieldName": "BillingAddress", "accessible": true},
                {"name": "Site", "type": "location", "accessible": true},
                {"name": "Secret__c", "type": "string", "accessible": false},
                // No `accessible` flag at all: the org did not report FLS, keep it.
                {"name": "Legacy__c", "type": "string"}
            ]
        });
        let names: Vec<String> = parse_describe_columns(&describe).iter().map(|column| column.name.clone()).collect();
        assert_eq!(names, vec!["Id", "BillingStreet", "Legacy__c"]);
    }

    #[test]
    fn describe_columns_extra_has_label_relationship_and_reference() {
        let describe = serde_json::json!({
            "fields": [
                {
                    "name": "StageName",
                    "label": "Stage",
                    "type": "picklist",
                    "nillable": false,
                    "updateable": true,
                    "createable": true,
                    "picklistValues": [
                        {"value": "Prospecting", "active": true},
                        {"value": "Closed", "active": true},
                        {"value": "Old", "active": false}
                    ]
                },
                {
                    "name": "OwnerId",
                    "label": "Owner ID",
                    "type": "reference",
                    "nillable": false,
                    "updateable": true,
                    "createable": true,
                    "relationshipName": "Owner",
                    "referenceTo": ["User"]
                },
                {
                    "name": "Name",
                    "label": "Account Name",
                    "type": "string",
                    "nillable": false,
                    "updateable": true,
                    "createable": true,
                    "length": 255
                }
            ]
        });
        let columns = parse_describe_columns(&describe);
        assert_eq!(columns.len(), 3);

        // (a) picklist: enum_values only includes active values; extra has label
        let picklist_extra: Value = serde_json::from_str(columns[0].extra.as_ref().unwrap()).unwrap();
        assert_eq!(picklist_extra["label"], serde_json::json!("Stage"));
        assert_eq!(picklist_extra["updateable"], serde_json::json!(true));
        assert!(picklist_extra.get("relationshipName").is_none());
        assert!(picklist_extra.get("referenceTo").is_none());
        assert_eq!(columns[0].enum_values.as_ref().unwrap(), &vec!["Prospecting".to_string(), "Closed".to_string()]);

        // (b) reference: relationshipName and referenceTo present in extra
        let ref_extra: Value = serde_json::from_str(columns[1].extra.as_ref().unwrap()).unwrap();
        assert_eq!(ref_extra["label"], serde_json::json!("Owner ID"));
        assert_eq!(ref_extra["relationshipName"], serde_json::json!("Owner"));
        assert_eq!(ref_extra["referenceTo"], serde_json::json!(["User"]));
        assert!(columns[1].enum_values.is_none());

        // (c) plain string: label present, no relationship/reference
        let str_extra: Value = serde_json::from_str(columns[2].extra.as_ref().unwrap()).unwrap();
        assert_eq!(str_extra["label"], serde_json::json!("Account Name"));
        assert!(str_extra.get("relationshipName").is_none());
        assert!(str_extra.get("referenceTo").is_none());
    }

    #[test]
    fn describe_columns_reference_empty_array_omitted() {
        let describe = serde_json::json!({
            "fields": [{
                "name": "LookupId",
                "label": "Lookup",
                "type": "reference",
                "nillable": true,
                "referenceTo": [],
                "relationshipName": null
            }]
        });
        let columns = parse_describe_columns(&describe);
        assert_eq!(columns.len(), 1);
        let extra: Value = serde_json::from_str(columns[0].extra.as_ref().unwrap()).unwrap();
        assert!(extra.get("referenceTo").is_none(), "empty referenceTo must be omitted");
        assert!(extra.get("relationshipName").is_none(), "null relationshipName must be omitted");
    }

    #[test]
    fn error_message_hints_known_codes() {
        let body = serde_json::json!([{ "errorCode": "MALFORMED_QUERY", "message": "unexpected token: FROMM" }]);
        let message = salesforce_error_message(StatusCode::BAD_REQUEST, &body);
        assert!(message.contains("MALFORMED_QUERY"));
        assert!(message.contains("SOQL syntax error"));
    }

    #[test]
    fn error_message_hints_fields_limit_rule() {
        let body = serde_json::json!([{
            "errorCode": "MALFORMED_QUERY",
            "message": "The SOQL FIELDS function must have a LIMIT of at most 200"
        }]);
        let message = salesforce_error_message(StatusCode::BAD_REQUEST, &body);
        assert!(message.contains("requires LIMIT 200 or less"));
    }

    #[test]
    fn fields_function_appends_limit_when_missing() {
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account"),
            "SELECT FIELDS(ALL) FROM Account LIMIT 200"
        );
        assert_eq!(
            apply_fields_function_limit("select fields(standard) from Contact"),
            "select fields(standard) from Contact LIMIT 200"
        );
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS ( CUSTOM ) FROM Account"),
            "SELECT FIELDS ( CUSTOM ) FROM Account LIMIT 200"
        );
        // Trailing semicolon/whitespace is trimmed before appending.
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account;  "),
            "SELECT FIELDS(ALL) FROM Account LIMIT 200"
        );
    }

    #[test]
    fn fields_function_keeps_existing_limit_untouched() {
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account LIMIT 5"),
            "SELECT FIELDS(ALL) FROM Account LIMIT 5"
        );
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account LIMIT 5000"),
            "SELECT FIELDS(ALL) FROM Account LIMIT 5000"
        );
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account limit 10"),
            "SELECT FIELDS(ALL) FROM Account limit 10"
        );
    }

    #[test]
    fn non_fields_queries_are_untouched() {
        assert_eq!(apply_fields_function_limit("SELECT Id, Name FROM Account"), "SELECT Id, Name FROM Account");
        // `LIMIT` inside a string literal must not suppress the append.
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account WHERE Name = 'LIMIT'"),
            "SELECT FIELDS(ALL) FROM Account WHERE Name = 'LIMIT' LIMIT 200"
        );
        // `FIELDS(ALL)` inside a string literal must not trigger the append.
        assert_eq!(
            apply_fields_function_limit("SELECT Id FROM Account WHERE Name = 'FIELDS(ALL)'"),
            "SELECT Id FROM Account WHERE Name = 'FIELDS(ALL)'"
        );
        // A word containing LIMIT (e.g. a custom field) is not a LIMIT clause.
        assert_eq!(
            apply_fields_function_limit("SELECT FIELDS(ALL) FROM Account ORDER BY LIMIT__c"),
            "SELECT FIELDS(ALL) FROM Account ORDER BY LIMIT__c LIMIT 200"
        );
    }

    #[test]
    fn from_config_requires_token_and_valid_version() {
        assert!(SfClient::from_config("acme.my.salesforce.com", None, None, Duration::from_secs(5)).is_err());
        let bad_version = serde_json::json!({ "apiVersion": "nope" });
        assert!(SfClient::from_config(
            "acme.my.salesforce.com",
            Some("tok"),
            Some(&bad_version),
            Duration::from_secs(5)
        )
        .is_err());
        let client =
            SfClient::from_config("acme.my.salesforce.com", Some("tok"), None, Duration::from_secs(5)).unwrap();
        assert_eq!(client.instance_url(), "https://acme.my.salesforce.com");
        assert_eq!(client.api_base(), "https://acme.my.salesforce.com/services/data/v62.0");
    }

    #[test]
    fn query_cursors_resolve_only_against_the_connected_org() {
        let client =
            SfClient::from_config("acme--qas1.sandbox.my.salesforce.com", Some("tok"), None, Duration::from_secs(5))
                .unwrap();

        // Relative cursors (and Salesforce's own absolute nextRecordsUrl) resolve as before.
        assert_eq!(
            client.resolve_cursor_url("/services/data/v62.0/query/01g-2000").unwrap(),
            "https://acme--qas1.sandbox.my.salesforce.com/services/data/v62.0/query/01g-2000"
        );
        assert_eq!(
            client
                .resolve_cursor_url("https://acme--qas1.sandbox.my.salesforce.com/services/data/v62.0/query/01g-2000")
                .unwrap(),
            "https://acme--qas1.sandbox.my.salesforce.com/services/data/v62.0/query/01g-2000"
        );
        // Host casing and the explicit default port are still the same origin.
        assert_eq!(
            client
                .resolve_cursor_url(
                    "https://ACME--qas1.sandbox.my.salesforce.com:443/services/data/v62.0/query/01g-2000"
                )
                .unwrap(),
            "https://ACME--qas1.sandbox.my.salesforce.com:443/services/data/v62.0/query/01g-2000"
        );

        // A cursor pointing anywhere else would carry the bearer token with it.
        let foreign = client.resolve_cursor_url("https://collector.example.com/records");
        assert!(foreign.is_err(), "foreign-origin cursor must be refused");
        assert!(foreign.unwrap_err().contains("outside the connected org"));
        // Plain HTTP is never the same origin as the HTTPS instance URL.
        assert!(client
            .resolve_cursor_url("http://acme--qas1.sandbox.my.salesforce.com/services/data/v62.0/query/01g-2000")
            .is_err());
        // A same-host cursor on a different port is a different origin.
        assert!(client.resolve_cursor_url("https://acme--qas1.sandbox.my.salesforce.com:8443/query/01g-2000").is_err());
    }

    #[test]
    fn from_config_accepts_empty_token_when_oauth_refresh_is_configured() {
        let oauth_config = serde_json::json!({
            "apiVersion": "v62.0",
            "auth": {
                "environment": "sandbox",
                "clientId": "3MVG9xxx",
                "refreshToken": "refresh-abc"
            }
        });
        // empty access token + refresh context is allowed (first request refreshes)
        let client = SfClient::from_config(
            "acme--qas1.sandbox.my.salesforce.com",
            Some(""),
            Some(&oauth_config),
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(client.has_refresh_token());
        assert_eq!(client.current_token(), "");
        // debug output must never leak token material
        let debug = format!("{client:?}");
        assert!(!debug.contains("refresh-abc"));
        assert!(!debug.contains("3MVG9xxx"));
        assert!(debug.contains("<redacted>"));
        // token-only connections have no refresh context
        let manual =
            SfClient::from_config("acme.my.salesforce.com", Some("tok"), None, Duration::from_secs(5)).unwrap();
        assert!(!manual.has_refresh_token());
        // auth block without refreshToken keeps the strict token requirement
        let incomplete = serde_json::json!({ "auth": { "clientId": "x" } });
        assert!(
            SfClient::from_config("acme.my.salesforce.com", None, Some(&incomplete), Duration::from_secs(5)).is_err()
        );
        // username-password mode: stored credentials also satisfy the empty-token rule
        let ropc = serde_json::json!({
            "auth": {
                "mode": "password",
                "environment": "sandbox",
                "clientId": "3MVG9xxx",
                "clientSecret": "secret",
                "username": "user@example.com.qas1",
                "password": "pw"
            }
        });
        let ropc_client = SfClient::from_config(
            "acme--qas1.sandbox.my.salesforce.com",
            Some(""),
            Some(&ropc),
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(ropc_client.has_refresh_token());
        let ropc_debug = format!("{ropc_client:?}");
        assert!(!ropc_debug.contains("user@example.com"), "{ropc_debug}");
    }

    #[test]
    fn parse_salesforce_statement_insert() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"insert\",\"object\":\"Account\",\"fields\":{\"Name\":\"Acme\"}}";
        let stmt = parse_salesforce_statement(source).unwrap();
        assert_eq!(stmt.op, SfDmlOp::Insert);
        assert_eq!(stmt.object, "Account");
        assert!(stmt.id.is_none());
        let fields = stmt.fields.unwrap();
        assert_eq!(fields.get("Name").and_then(Value::as_str), Some("Acme"));
    }

    #[test]
    fn parse_salesforce_statement_update() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"update\",\"object\":\"Account\",\"id\":\"001xx000003DGbY\",\"fields\":{\"Name\":\"Acme\"}}";
        let stmt = parse_salesforce_statement(source).unwrap();
        assert_eq!(stmt.op, SfDmlOp::Update);
        assert_eq!(stmt.object, "Account");
        assert_eq!(stmt.id.as_deref(), Some("001xx000003DGbY"));
    }

    #[test]
    fn parse_salesforce_statement_delete() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"delete\",\"object\":\"Account\",\"id\":\"001xx000003DGbY\"}";
        let stmt = parse_salesforce_statement(source).unwrap();
        assert_eq!(stmt.op, SfDmlOp::Delete);
        assert_eq!(stmt.id.as_deref(), Some("001xx000003DGbY"));
        assert!(stmt.fields.is_none());
    }

    #[test]
    fn parse_salesforce_statement_case_insensitive_header() {
        let source = "dbx salesforce dml\n{\"op\":\"delete\",\"object\":\"Lead\",\"id\":\"abc\"}";
        let stmt = parse_salesforce_statement(source).unwrap();
        assert_eq!(stmt.op, SfDmlOp::Delete);
    }

    #[test]
    fn parse_salesforce_statement_malformed_json() {
        let source = "DBX SALESFORCE DML\n{not json";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("Invalid DBX SALESFORCE DML JSON body"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_unknown_op() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"upsert\",\"object\":\"Account\",\"id\":\"x\"}";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("Unknown DBX SALESFORCE DML op"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_missing_id_for_update() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"update\",\"object\":\"Account\",\"fields\":{\"Name\":\"x\"}}";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("requires a non-empty 'id'"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_missing_id_for_delete() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"delete\",\"object\":\"Account\"}";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("requires a non-empty 'id'"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_empty_fields_for_insert() {
        let source = "DBX SALESFORCE DML\n{\"op\":\"insert\",\"object\":\"Account\",\"fields\":{}}";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("non-empty 'fields'"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_non_dbx_soql_is_not_matched() {
        // Plain SOQL never enters the parser — but if it somehow did, the
        // header check catches it.
        let source = "SELECT Id FROM Account";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("Unsupported DBX SALESFORCE statement"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_unknown_header() {
        let source = "DBX SALESFORCE SOMETHING\n{}";
        let err = parse_salesforce_statement(source).unwrap_err();
        assert!(err.contains("Unsupported DBX SALESFORCE statement"), "{err}");
    }

    #[test]
    fn parse_salesforce_statement_empty_input() {
        let err = parse_salesforce_statement("").unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn starts_with_salesforce_header_detects_dml() {
        assert!(starts_with_salesforce_header("DBX SALESFORCE DML\n{}"));
        assert!(starts_with_salesforce_header("  dbx salesforce dml\n{}"));
        assert!(!starts_with_salesforce_header("SELECT Id FROM Account"));
        assert!(!starts_with_salesforce_header(""));
    }
}
