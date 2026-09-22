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

use reqwest::{Client as HttpClient, Method, StatusCode};
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

    /// Execute a SOQL query. `max_rows` caps materialized rows; remaining rows
    /// stay behind `has_more` + QueryLocator (`session_id`).
    pub async fn execute_query(&self, soql: &str, max_rows: Option<usize>) -> Result<QueryResult, String> {
        let started = Instant::now();
        let url = format!("{}/query?q={}", self.api_base(), urlencoded(soql));
        let value = self.api_get(&url).await?;
        let limit = max_rows.unwrap_or(SALESFORCE_MAX_ROWS_PER_BATCH).max(1);
        Ok(parse_soql_response(value, started.elapsed().as_millis(), limit))
    }

    /// Fetch the next page using a QueryLocator URL returned as `session_id`.
    pub async fn fetch_more(&self, cursor: &str) -> Result<QueryResult, String> {
        let started = Instant::now();
        let url = if cursor.starts_with("http://") || cursor.starts_with("https://") {
            cursor.to_string()
        } else {
            format!("{}{}", self.instance_url, cursor)
        };
        let value = self.api_get(&url).await?;
        Ok(parse_soql_response(value, started.elapsed().as_millis(), SALESFORCE_MAX_ROWS_PER_BATCH))
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
            Value::Object(_) if child.get("records").is_none() && depth < 2 => {
                flatten_record(child, &path, out, depth + 1);
            }
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

fn parse_describe_columns(describe: &Value) -> Vec<ColumnInfo> {
    describe
        .get("fields")
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
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
        "MALFORMED_QUERY" => Some("SOQL syntax error — check the query near the position Salesforce reports."),
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
}
