use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::{Duration, Instant};

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::Encryptor as Aes128CbcEncryptor;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::nacos::config::{NacosAdminConfig, NacosApiPlane, NacosAuthConfig, NacosImplementation, NacosVersionMode};
use crate::nacos::port::{NacosAdmin, NacosNamespaceAuthorizationSnapshot};
use crate::nacos::types::*;

const REQUEST_TIMEOUT_SECS: u64 = 30;
// Matches r-nacos' default RNACOS_CONSOLE_LOGIN_TIMEOUT. If an installation
// uses a shorter timeout, the console's NO_LOGIN response invalidates this
// optimistic cache and starts a fresh login flow.
pub(crate) const RNACOS_CONSOLE_SESSION_CACHE_SECS: u64 = 86_400;
const MAX_RAW_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const NACOS_ERROR_PREFIX: &str = "NACOS_ERROR";
const ACCESS_CONTROL_CAPABILITY_CACHE_TTL: Duration = Duration::from_secs(60);
const ACCESS_CONTROL_PROBE_PAGE_SIZE: u32 = 500;
const ADMIN_ROLE: &str = "ROLE_ADMIN";
const CONSOLE_USERS_RESOURCE: &str = "console/users";
const CONSOLE_ROLES_RESOURCE: &str = "console/roles";
const CONSOLE_PERMISSIONS_RESOURCE: &str = "console/permissions";

#[derive(Clone)]
struct CachedAccessControlCapabilities {
    capabilities: NacosAccessControlCapabilities,
    authorization: Option<CachedOfficialAuthorization>,
    expires_at: Instant,
}

#[derive(Clone)]
struct CachedOfficialAuthorization {
    username: String,
    role_bindings: Result<NacosRoleList, String>,
    permissions: Result<NacosPermissionList, String>,
}

fn access_control_probe_reason(error: &str) -> NacosCapabilityReason {
    let lower = error.to_ascii_lowercase();
    if lower.contains("403")
        || lower.contains("401")
        || lower.contains("forbidden")
        || lower.contains("unauthorized")
        || lower.contains("access denied")
    {
        NacosCapabilityReason::PermissionDenied
    } else if lower.contains("404")
        || lower.contains("405")
        || lower.contains("not found")
        || lower.contains("no static resource")
    {
        NacosCapabilityReason::EndpointUnavailable
    } else {
        NacosCapabilityReason::NotVerified
    }
}

fn read_capability<T>(result: &Result<T, String>) -> NacosOperationCapability {
    match result {
        Ok(_) => NacosOperationCapability::supported(),
        Err(error) => NacosOperationCapability::unsupported(access_control_probe_reason(error)),
    }
}

fn write_capability(
    read: &NacosOperationCapability,
    authorization_complete: bool,
    granted: bool,
) -> NacosOperationCapability {
    if !read.supported {
        return read.clone();
    }
    if !authorization_complete {
        return NacosOperationCapability::unsupported(NacosCapabilityReason::NotVerified);
    }
    if granted {
        NacosOperationCapability::supported()
    } else {
        NacosOperationCapability::unsupported(NacosCapabilityReason::PermissionDenied)
    }
}

fn official_unverified_access_control() -> NacosAccessControlCapabilities {
    let unavailable = NacosOperationCapability::unsupported(NacosCapabilityReason::NotVerified);
    NacosAccessControlCapabilities {
        mode: NacosAccessControlMode::RoleBindings,
        list_users: unavailable.clone(),
        create_user: unavailable.clone(),
        update_user: unavailable.clone(),
        delete_user: unavailable.clone(),
        list_role_bindings: unavailable.clone(),
        assign_role: unavailable.clone(),
        remove_role: unavailable.clone(),
        list_permissions: unavailable.clone(),
        grant_permission: unavailable.clone(),
        revoke_permission: unavailable,
        enhanced_workspace: false,
        supports_namespace_privileges: false,
    }
}

fn official_full_access_control() -> NacosAccessControlCapabilities {
    NacosAccessControlCapabilities {
        mode: NacosAccessControlMode::RoleBindings,
        list_users: NacosOperationCapability::supported(),
        create_user: NacosOperationCapability::supported(),
        update_user: NacosOperationCapability::supported(),
        delete_user: NacosOperationCapability::supported(),
        list_role_bindings: NacosOperationCapability::supported(),
        assign_role: NacosOperationCapability::supported(),
        remove_role: NacosOperationCapability::supported(),
        list_permissions: NacosOperationCapability::supported(),
        grant_permission: NacosOperationCapability::supported(),
        revoke_permission: NacosOperationCapability::supported(),
        enhanced_workspace: true,
        supports_namespace_privileges: false,
    }
}

#[derive(Debug, Clone)]
struct AccessToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct RNacosConsoleToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct RNacosConsoleCaptchaToken {
    token: String,
    expires_at: Instant,
}

/// Short-lived r-nacos console state shared by clients for one DBX connection.
/// It deliberately remains in memory so closing a console tab does not trigger
/// a new CAPTCHA, while restarting DBX still requires authentication.
#[derive(Debug, Default)]
pub(crate) struct RNacosConsoleSession {
    token: Option<RNacosConsoleToken>,
    captcha: Option<RNacosConsoleCaptchaToken>,
}

pub(crate) type RNacosConsoleSessionHandle = Arc<Mutex<RNacosConsoleSession>>;

pub(crate) fn new_rnacos_console_session() -> RNacosConsoleSessionHandle {
    Arc::new(Mutex::new(RNacosConsoleSession::default()))
}

#[derive(Debug)]
struct NacosServerStateProbe {
    raw: Value,
    is_rnacos_compatible: bool,
}

pub struct NacosOpenApiAdmin {
    cfg: NacosAdminConfig,
    http: reqwest::Client,
    token: Mutex<Option<AccessToken>>,
    rnacos_console_session: RNacosConsoleSessionHandle,
    detected_rnacos: AtomicBool,
    detected_major_version: AtomicU8,
    managed_namespace_fallback_used: AtomicBool,
    global_admin: AtomicU8,
    access_control_capabilities: StdRwLock<Option<CachedAccessControlCapabilities>>,
}

impl NacosOpenApiAdmin {
    pub fn new(cfg: NacosAdminConfig) -> Result<Self, String> {
        Self::new_with_rnacos_console_session(cfg, new_rnacos_console_session())
    }

    pub(crate) fn new_with_rnacos_console_session(
        cfg: NacosAdminConfig,
        rnacos_console_session: RNacosConsoleSessionHandle,
    ) -> Result<Self, String> {
        let mut builder =
            reqwest::Client::builder().timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS)).cookie_store(true);
        if cfg.tls_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().map_err(|e| format!("Failed to build Nacos HTTP client: {e}"))?;
        let detected_rnacos = AtomicBool::new(matches!(cfg.implementation, Some(NacosImplementation::RNacos)));
        let detected_major_version = AtomicU8::new(match cfg.version_mode {
            Some(NacosVersionMode::V3) => 3,
            // New connections must choose a version in the UI. Keep legacy
            // omitted/`auto` values deterministic rather than probing across
            // API generations: they follow the established v2 Naming API.
            Some(NacosVersionMode::V2) | Some(NacosVersionMode::Auto) | None => 2,
        });
        Ok(Self {
            cfg,
            http,
            token: Mutex::new(None),
            rnacos_console_session,
            detected_rnacos,
            detected_major_version,
            managed_namespace_fallback_used: AtomicBool::new(false),
            global_admin: AtomicU8::new(0),
            access_control_capabilities: StdRwLock::new(None),
        })
    }

    fn endpoint_with_context(&self, path: &str, context_path: &str) -> Result<String, String> {
        self.endpoint_with_base(&self.cfg.server_addr, path, context_path)
    }

    fn endpoint_with_base(&self, server_addr: &str, path: &str, context_path: &str) -> Result<String, String> {
        let path = normalize_api_path(path);
        let context_path = normalize_api_path(context_path).trim_end_matches('/').to_string();
        let base = format!("{server_addr}{context_path}");
        let base = base.trim_end_matches('/');
        let full = if path.starts_with("/nacos/") && context_path == "/nacos" {
            format!("{server_addr}{path}")
        } else if path.starts_with("/rnacos/") && context_path.ends_with("/nacos") {
            // r-nacos documents this auth endpoint outside the Nacos-compatible
            // `/nacos` context. Preserve an optional proxy prefix such as
            // `/gateway/nacos` while replacing that final segment.
            let proxy_prefix = context_path.strip_suffix("/nacos").unwrap_or(&context_path);
            format!("{server_addr}{proxy_prefix}{path}")
        } else {
            format!("{base}{path}")
        };
        reqwest::Url::parse(&full).map(|url| url.to_string()).map_err(|e| format!("Nacos API URL is invalid: {e}"))
    }

    async fn send_with_context_fallback(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        body: Option<&Value>,
        auth_token: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let resp = self.send_once(method.clone(), path, &self.cfg.context_path, query, form, body, auth_token).await?;
        if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
            return Ok(resp);
        }
        if !self.should_retry_without_context(resp.status()) {
            return Ok(resp);
        }

        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        if self.cfg.context_path.trim().is_empty() || !looks_like_wrong_context_path(&detail, &self.cfg.context_path) {
            return Err(format!("Nacos admin {path} returned {status}: {}", detail.trim()));
        }
        self.send_once(method, path, "", query, form, body, auth_token).await
    }

    async fn send_once(
        &self,
        method: reqwest::Method,
        path: &str,
        context_path: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        body: Option<&Value>,
        auth_token: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let endpoint = self.endpoint_with_context(path, context_path)?;
        let mut req = self.http.request(method, endpoint).query(query);
        if let Some(token) = auth_token {
            req = req.header("accessToken", token);
        }
        if let Some(form) = form {
            req = req.form(form);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        req.send().await.map_err(|e| format!("Nacos request to {path} failed: {e}"))
    }

    fn should_retry_without_context(&self, status: reqwest::StatusCode) -> bool {
        !self.cfg.context_path.trim().is_empty()
            && (status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::INTERNAL_SERVER_ERROR)
    }

    fn auth_login_paths(&self) -> &'static [&'static str] {
        const NACOS_PATHS: &[&str] = &["/v1/auth/users/login", "/v1/auth/login", "/v3/auth/user/login"];
        const COMPATIBLE_PATHS: &[&str] =
            &["/v1/auth/users/login", "/v1/auth/login", "/v3/auth/user/login", "/rnacos/v1/auth/user/login"];

        match self.cfg.implementation.as_ref() {
            Some(NacosImplementation::Nacos) => NACOS_PATHS,
            Some(NacosImplementation::RNacos) => COMPATIBLE_PATHS,
            // Legacy records predate implementation selection and may point to
            // either Nacos or r-nacos, so retain the existing automatic probes.
            None => COMPATIBLE_PATHS,
        }
    }

    async fn access_token(&self) -> Result<Option<String>, String> {
        let NacosAuthConfig::UsernamePassword { username, password } = &self.cfg.auth else {
            return Ok(None);
        };
        if username.trim().is_empty() {
            return Ok(None);
        }
        {
            let guard = self.token.lock().await;
            if let Some(token) = guard.as_ref() {
                if token.expires_at > Instant::now() + Duration::from_secs(30) {
                    return Ok(Some(token.token.clone()));
                }
            }
        }

        let form = vec![("username".to_string(), username.to_string()), ("password".to_string(), password.to_string())];
        let mut errors = Vec::new();
        let mut resp = None;
        for &path in self.auth_login_paths() {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.send_with_context_fallback(reqwest::Method::POST, path, &[], Some(&form), None, None).await {
                Ok(value) if value.status().is_success() => {
                    resp = Some(value);
                    break;
                }
                Ok(value) => match error_for_status(value, path).await {
                    Ok(value) => {
                        resp = Some(value);
                        break;
                    }
                    Err(err) => errors.push(err),
                },
                Err(err) => errors.push(err),
            }
        }
        let resp = resp.ok_or_else(|| {
            errors
                .iter()
                .find(|error| classify_nacos_error(error) == "authFailed")
                .or_else(|| errors.last())
                .cloned()
                .unwrap_or_else(|| "Nacos auth request failed".to_string())
        })?;
        let value: Value = resp.json().await.map_err(|e| format!("Failed to parse Nacos auth response: {e}"))?;
        let token_source = value.get("data").filter(|value| value.is_object()).unwrap_or(&value);
        let token = token_source
            .get("accessToken")
            .or_else(|| token_source.get("access_token"))
            .or_else(|| token_source.get("token"))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Nacos auth response did not include an access token: {value}"))?
            .to_string();
        let ttl = token_source
            .get("tokenTtl")
            .or_else(|| token_source.get("expiresIn"))
            .or_else(|| token_source.get("expireSeconds"))
            .and_then(Value::as_u64)
            .unwrap_or(18_000);
        if let Some(global_admin) =
            token_source.get("globalAdmin").or_else(|| token_source.get("global_admin")).and_then(Value::as_bool)
        {
            self.global_admin.store(if global_admin { 2 } else { 1 }, Ordering::Relaxed);
        }
        *self.token.lock().await = Some(AccessToken {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(ttl.saturating_sub(30).max(60)),
        });
        Ok(Some(token))
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        mut query: Vec<(String, String)>,
        form: Option<Vec<(String, String)>>,
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        let token = self.access_token().await?;
        // Token transport follows the endpoint generation, not only the
        // detected server version: Nacos 3 can deliberately fall back to a
        // legacy V1 namespace directory, whose auth contract uses a query
        // parameter rather than the V3 accessToken header.
        let header_token = if path.starts_with("/v3/") {
            token.as_deref()
        } else {
            if let Some(token) = token {
                query.push(("accessToken".to_string(), token));
            }
            None
        };
        self.send_with_context_fallback(method, path, &query, form.as_deref(), body.as_ref(), header_token).await
    }

    async fn get_json(&self, path: &str, query: Vec<(String, String)>) -> Result<Value, String> {
        let resp = self.request(reqwest::Method::GET, path, query, None, None).await?;
        let resp = error_for_status(resp, path).await?;
        let value = response_json_or_text(resp).await?;
        validate_nacos_json_authorization(&value, path)?;
        Ok(value)
    }

    async fn get_json_without_auth(&self, path: &str, query: Vec<(String, String)>) -> Result<Value, String> {
        let resp = self.send_with_context_fallback(reqwest::Method::GET, path, &query, None, None, None).await?;
        let resp = error_for_status(resp, path).await?;
        response_json_or_text(resp).await
    }

    fn rnacos_console_endpoint(&self, path: &str) -> Result<String, String> {
        if self.cfg.rnacos_console_addr.is_empty() {
            return Err(
                "r-nacos configuration metadata and history require an r-nacos console URL (the independent console service, normally port 10848)"
                    .to_string(),
            );
        }
        let mut url = reqwest::Url::parse(&self.cfg.rnacos_console_addr)
            .map_err(|e| format!("r-nacos console API URL is invalid: {e}"))?;
        let base_path = url.path().trim_end_matches('/');
        let mut path = normalize_api_path(path);
        // A browser URL commonly ends in /rnacos. The API paths also start
        // there, so consume one prefix before joining rather than producing
        // /rnacos/rnacos/api/... . Proxy prefixes remain intact.
        if base_path.ends_with("/rnacos") {
            path = path.strip_prefix("/rnacos").unwrap_or(&path).to_string();
        }
        let joined = format!("{}{}", base_path, path);
        url.set_path(&joined);
        Ok(url.to_string())
    }

    async fn rnacos_console_token(&self) -> Result<String, String> {
        self.cfg.effective_rnacos_console_credentials()?;
        {
            let guard = self.rnacos_console_session.lock().await;
            if let Some(token) = guard.token.as_ref() {
                if token.expires_at > Instant::now() + Duration::from_secs(30) {
                    return Ok(token.token.clone());
                }
            }
        }

        let captcha = self.fetch_rnacos_console_captcha().await?;
        if captcha.required {
            return Err(classified_error(
                "rnacosConsoleCaptchaRequired",
                "r-nacos console requires a CAPTCHA before configuration metadata or history can be accessed",
            ));
        }
        self.login_rnacos_console_with_captcha(None).await
    }

    async fn fetch_rnacos_console_captcha(&self) -> Result<NacosRNacosConsoleCaptcha, String> {
        let path = "/rnacos/api/console/v2/login/captcha";
        let response = self
            .http
            .get(self.rnacos_console_endpoint(path)?)
            .send()
            .await
            .map_err(|e| format!("r-nacos console captcha request failed: {e}"))?;
        let headers = response.headers().clone();
        let response = error_for_status(response, "r-nacos console captcha").await?;
        let value: Value =
            response.json().await.map_err(|e| format!("Failed to parse r-nacos console captcha response: {e}"))?;
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(format!("r-nacos console captcha request failed: {}", rnacos_console_error_detail(&value)));
        }
        let image = value.get("data").and_then(Value::as_str).map(str::to_string);
        if image.is_some() {
            let token = headers
                .get("captcha-token")
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "r-nacos console CAPTCHA response did not include a captcha token".to_string())?;
            self.rnacos_console_session.lock().await.captcha = Some(RNacosConsoleCaptchaToken {
                token: token.to_string(),
                expires_at: Instant::now() + Duration::from_secs(300),
            });
        } else {
            self.rnacos_console_session.lock().await.captcha = None;
        }
        Ok(NacosRNacosConsoleCaptcha { required: image.is_some(), image })
    }

    async fn login_rnacos_console_with_captcha(&self, captcha: Option<String>) -> Result<String, String> {
        let (username, password) = self.cfg.effective_rnacos_console_credentials()?;
        let captcha = captcha.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let captcha_token = {
            let guard = self.rnacos_console_session.lock().await;
            guard.captcha.as_ref().filter(|value| value.expires_at > Instant::now()).map(|value| value.token.clone())
        };
        if captcha.is_some() && captcha_token.is_none() {
            return Err(classified_error(
                "rnacosConsoleCaptchaExpired",
                "r-nacos console CAPTCHA expired; request a new CAPTCHA and try again",
            ));
        }

        let encoded_password = rnacos_console_password(password, captcha_token.as_deref())?;
        let mut form = vec![("username", username.to_string()), ("password", encoded_password)];
        if let Some(captcha) = captcha {
            form.push(("captcha", captcha));
        }
        let path = "/rnacos/api/console/v2/login/login";
        let mut request = self.http.post(self.rnacos_console_endpoint(path)?).form(&form);
        if let Some(captcha_token) = captcha_token {
            request = request.header("Cookie", format!("captcha_token={captcha_token}"));
        }
        let response = request.send().await.map_err(|e| format!("r-nacos console login request failed: {e}"))?;
        let response = error_for_status(response, "r-nacos console login").await?;
        let value: Value =
            response.json().await.map_err(|e| format!("Failed to parse r-nacos console login response: {e}"))?;
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(format!("r-nacos console login failed: {}", rnacos_console_error_detail(&value)));
        }
        let token = value
            .get("data")
            .and_then(|data| data.get("token"))
            .and_then(Value::as_str)
            .ok_or_else(|| "r-nacos console login response did not include a token".to_string())?
            .to_string();
        // r-nacos does not return the session TTL. Keep the token for its
        // documented default lifetime; get_rnacos_console_json invalidates it
        // immediately when a deployment with a shorter timeout returns NO_LOGIN.
        let mut session = self.rnacos_console_session.lock().await;
        session.token = Some(RNacosConsoleToken {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(RNACOS_CONSOLE_SESSION_CACHE_SECS),
        });
        session.captcha = None;
        Ok(token)
    }

    async fn get_rnacos_console_json(&self, path: &str, query: Vec<(String, String)>) -> Result<Value, String> {
        let mut retried_after_expired_session = false;
        loop {
            let token = self.rnacos_console_token().await?;
            let response = self
                .http
                .get(self.rnacos_console_endpoint(path)?)
                .header("Token", token.clone())
                .query(&query)
                .send()
                .await
                .map_err(|e| format!("r-nacos console request to {path} failed: {e}"))?;
            let response = error_for_status(response, path).await?;
            let value = response_json_or_text(response).await?;
            if value.get("success").and_then(Value::as_bool) != Some(false) {
                return Ok(value);
            }
            if !retried_after_expired_session && rnacos_console_session_expired(&value) {
                self.clear_rnacos_console_token_if_matches(&token).await;
                retried_after_expired_session = true;
                continue;
            }
            return Err(format!("r-nacos console {path} failed: {}", rnacos_console_error_detail(&value)));
        }
    }

    async fn post_rnacos_console_json(&self, path: &str, body: Value) -> Result<Value, String> {
        let mut retried_after_expired_session = false;
        loop {
            let token = self.rnacos_console_token().await?;
            let response = self
                .http
                .post(self.rnacos_console_endpoint(path)?)
                .header("Token", token.clone())
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("r-nacos console request to {path} failed: {e}"))?;
            let response = error_for_status(response, path).await?;
            let value = response_json_or_text(response).await?;
            if value.get("success").and_then(Value::as_bool) == Some(true) {
                return Ok(value);
            }
            if !retried_after_expired_session && rnacos_console_session_expired(&value) {
                self.clear_rnacos_console_token_if_matches(&token).await;
                retried_after_expired_session = true;
                continue;
            }
            return Err(format!("r-nacos console {path} failed: {}", rnacos_console_error_detail(&value)));
        }
    }

    async fn get_rnacos_console_json_without_login(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<Value, String> {
        let response = self
            .http
            .get(self.rnacos_console_endpoint(path)?)
            .query(query)
            .send()
            .await
            .map_err(|e| format!("r-nacos console request to {path} failed: {e}"))?;
        let response = error_for_status(response, path).await?;
        let value = response_json_or_text(response).await?;
        match value.get("success").and_then(Value::as_bool) {
            Some(true) => Ok(value),
            Some(false) => Err(format!("r-nacos console {path} failed: {}", rnacos_console_error_detail(&value))),
            None => Err(format!(
                "r-nacos console {path} returned an unexpected unauthenticated response instead of API JSON"
            )),
        }
    }

    /// Metadata reads also support `RNACOS_ENABLE_NO_AUTH_CONSOLE=true`.
    /// Once an authenticated session exists, use it directly. Before login,
    /// first try the endpoint without a token and only start the CAPTCHA-aware
    /// login flow when the console actually rejects the anonymous request.
    async fn get_rnacos_console_metadata_json(
        &self,
        path: &str,
        query: Vec<(String, String)>,
    ) -> Result<Value, String> {
        let has_valid_token = self
            .rnacos_console_session
            .lock()
            .await
            .token
            .as_ref()
            .is_some_and(|token| token.expires_at > Instant::now() + Duration::from_secs(30));
        if has_valid_token {
            return self.get_rnacos_console_json(path, query).await;
        }

        match self.get_rnacos_console_json_without_login(path, &query).await {
            Ok(value) => Ok(value),
            Err(anonymous_error) if self.cfg.has_effective_rnacos_console_credentials() => self
                .get_rnacos_console_json(path, query)
                .await
                .map_err(|authenticated_error| {
                    format!(
                        "{authenticated_error}; anonymous r-nacos console metadata request also failed: {anonymous_error}"
                    )
                }),
            Err(error) => Err(error),
        }
    }

    /// The Nacos-compatible discovery endpoint intentionally hides disabled
    /// instances. r-nacos's own management console exposes the complete
    /// administrative view instead, including `enabled = false` instances.
    ///
    /// This requires the separately configured console endpoint and its
    /// session token, so callers retain the compatible OpenAPI fallback when
    /// a console is unavailable. A CAPTCHA requirement is deliberately
    /// propagated for the UI to complete the existing interactive login flow.
    async fn list_rnacos_console_instances(
        &self,
        query: &NacosInstanceQuery,
        namespace: &str,
        requested_clusters: &[String],
    ) -> Result<Vec<NacosInstanceInfo>, String> {
        let mut params = vec![
            ("namespaceId".to_string(), namespace.to_string()),
            ("serviceName".to_string(), query.service_name.clone()),
        ];
        push_optional(&mut params, "groupName", query.group_name.clone());
        let value = self.get_rnacos_console_json("/rnacos/api/console/v2/instance/list", params).await?;
        Ok(filter_instances_by_clusters(parse_instances(value), requested_clusters))
    }

    /// Do not let an older in-flight request invalidate a newer session that
    /// another configuration-history request has already refreshed.
    async fn clear_rnacos_console_token_if_matches(&self, token: &str) {
        let mut session = self.rnacos_console_session.lock().await;
        if session.token.as_ref().is_some_and(|current| current.token == token) {
            session.token = None;
        }
    }

    /// r-nacos exposes its build version through a console endpoint. Do not
    /// initiate console login here: CAPTCHA is an explicit user interaction
    /// for configuration history, not a prerequisite for opening a connection.
    async fn rnacos_console_version_if_authenticated(&self) -> Option<String> {
        let token = {
            let session = self.rnacos_console_session.lock().await;
            session
                .token
                .as_ref()
                .filter(|token| token.expires_at > Instant::now() + Duration::from_secs(30))
                .map(|token| token.token.clone())
        }?;
        let response = self
            .http
            .get(self.rnacos_console_endpoint("/rnacos/api/console/v2/user/web_resources").ok()?)
            .header("Token", token.clone())
            .send()
            .await
            .ok()?;
        let response = error_for_status(response, "r-nacos console version").await.ok()?;
        let value = response_json_or_text(response).await.ok()?;
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            if rnacos_console_session_expired(&value) {
                self.clear_rnacos_console_token_if_matches(&token).await;
            }
            return None;
        }
        value
            .pointer("/data/version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|version| !version.is_empty())
            .map(|version| format!("r-nacos {version}"))
    }

    async fn list_rnacos_config_history(
        &self,
        namespace: &str,
        data_id: &str,
        group: &str,
        page_no: u32,
        page_size: u32,
    ) -> Result<Value, String> {
        self.get_rnacos_console_json(
            "/rnacos/api/console/v2/config/history",
            vec![
                ("tenant".to_string(), namespace.to_string()),
                ("dataId".to_string(), data_id.to_string()),
                ("group".to_string(), group.to_string()),
                ("pageNo".to_string(), page_no.to_string()),
                ("pageSize".to_string(), page_size.to_string()),
            ],
        )
        .await
    }

    /// r-nacos stores detail (`value`, `configType`, `desc`, `md5`) on the console.
    async fn get_rnacos_console_config(
        &self,
        data_id: &str,
        group: &str,
        namespace: &str,
    ) -> Result<NacosConfigItem, String> {
        let value = self
            .get_rnacos_console_metadata_json(
                "/rnacos/api/console/v2/config/info",
                vec![
                    ("tenant".to_string(), namespace.to_string()),
                    ("dataId".to_string(), data_id.to_string()),
                    ("group".to_string(), group.to_string()),
                ],
            )
            .await?;
        Ok(parse_config_detail(value, data_id.to_string(), group.to_string(), namespace.to_string()))
    }

    /// OpenAPI default GET: response body is the configuration text only.
    async fn get_openapi_raw_config(
        &self,
        data_id: &str,
        group: &str,
        namespace: &str,
    ) -> Result<NacosConfigItem, String> {
        let query = vec![
            ("dataId".to_string(), data_id.to_string()),
            ("group".to_string(), group.to_string()),
            ("tenant".to_string(), namespace.to_string()),
        ];
        let resp = self.request(reqwest::Method::GET, "/v1/cs/configs", query, None, None).await?;
        let resp = error_for_status(resp, "/v1/cs/configs").await?;
        let text = resp.text().await.map_err(|e| format!("Failed to read Nacos config response: {e}"))?;
        // Never JSON-parse this body as a detail document: valid JSON configs are content (#6131).
        Ok(NacosConfigItem {
            data_id: data_id.to_string(),
            group: group.to_string(),
            namespace: namespace.to_string(),
            app_name: None,
            desc: None,
            tags: None,
            config_type: None,
            md5: None,
            encrypted_data_key: None,
            content: Some(text),
        })
    }

    async fn get_server_state(&self) -> Result<NacosServerStateProbe, String> {
        let mut errors = Vec::new();
        // r-nacos implements the Nacos client OpenAPI but not the console state endpoints.
        // Its documented health endpoint is mounted below the same `/nacos` context path,
        // so keep it last to preserve the richer official-Nacos state response when available.
        let paths: &[&str] = if matches!(self.cfg.implementation, Some(NacosImplementation::RNacos)) {
            &["/health", "/v3/admin/core/state", "/v1/ns/operator/servers", "/v1/console/server/state"]
        } else if self.is_v3_console() {
            &["/v3/console/server/state", "/v3/console/health/readiness", "/health"]
        } else {
            &["/v3/admin/core/state", "/v1/ns/operator/servers", "/v1/console/server/state", "/health"]
        };
        for &path in paths {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.get_json_without_auth(path, Vec::new()).await {
                Ok(raw) => {
                    let is_rnacos_compatible = path == "/health"
                        && raw.as_str().is_some_and(|value| value.trim().eq_ignore_ascii_case("success"));
                    return Ok(NacosServerStateProbe { raw, is_rnacos_compatible });
                }
                Err(err) => errors.push(err),
            }
        }
        Err(admin_endpoint_error(&self.cfg.server_addr, &errors))
    }

    fn is_explicit_rnacos(&self) -> bool {
        matches!(self.cfg.implementation, Some(NacosImplementation::RNacos))
    }

    fn is_rnacos_compatible(&self) -> bool {
        self.is_explicit_rnacos() || self.detected_rnacos.load(Ordering::Relaxed)
    }

    fn is_official_v3(&self) -> bool {
        !self.is_rnacos_compatible()
            && (matches!(self.cfg.version_mode, Some(NacosVersionMode::V3))
                || self.detected_major_version.load(Ordering::Relaxed) == 3)
    }

    fn is_v3_console(&self) -> bool {
        self.is_official_v3() && self.cfg.api_plane() == NacosApiPlane::Console
    }

    fn v3_path(&self, admin: &'static str, console: &'static str) -> &'static str {
        if self.is_v3_console() {
            console
        } else {
            admin
        }
    }

    fn api_path_allowed(&self, path: &str) -> bool {
        // r-nacos implements the Nacos-compatible v1 client OpenAPI, but it
        // does not expose official Nacos v2/v3 console or admin endpoints.
        // Treating its version as auto must not make a v3 probe the first
        // service-management request, because a normal 404 is intentionally
        // not retried across API generations.
        if self.is_rnacos_compatible() {
            return !path.starts_with("/v2/") && !path.starts_with("/v3/");
        }
        match self.detected_major_version.load(Ordering::Relaxed) {
            2 => !path.starts_with("/v3/"),
            3 => {
                let correct_plane = if self.cfg.api_plane() == NacosApiPlane::Console {
                    !path.starts_with("/v3/admin/")
                } else {
                    !path.starts_with("/v3/console/")
                };
                !path.starts_with("/v1/") && !path.starts_with("/v2/") && correct_plane
            }
            _ => true,
        }
    }

    fn should_try_next_candidate(&self, _error: &str) -> bool {
        // Nacos 2, Nacos 3 and r-nacos are explicitly selected connection
        // profiles. A failed request must remain a failure for that profile;
        // retrying it on a different API generation can mutate the wrong
        // endpoint or hide the real configuration error.
        false
    }

    fn namespace(&self, override_ns: Option<&str>) -> String {
        override_ns.unwrap_or(&self.cfg.namespace).trim().to_string()
    }

    async fn get_config_list_value(
        &self,
        namespace: &str,
        search: &str,
        group: &str,
        app_name: &str,
        page_no: u32,
        page_size: u32,
    ) -> Result<Value, String> {
        let mut v3_params = vec![
            ("search".to_string(), "blur".to_string()),
            ("dataId".to_string(), search.to_string()),
            ("groupName".to_string(), group.to_string()),
            ("namespaceId".to_string(), namespace.to_string()),
            ("configDetail".to_string(), String::new()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        push_optional(&mut v3_params, "appName", Some(app_name.to_string()));
        let mut attempts = vec![(self.v3_path("/v3/admin/cs/config/list", "/v3/console/cs/config/list"), v3_params)];
        let mut v1_params = vec![
            ("search".to_string(), "blur".to_string()),
            ("dataId".to_string(), search.to_string()),
            ("group".to_string(), group.to_string()),
            ("tenant".to_string(), namespace.to_string()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        push_optional(&mut v1_params, "appName", Some(app_name.to_string()));
        attempts.push(("/v1/cs/configs", v1_params));
        self.get_json_from_candidates("list Nacos configs", attempts).await
    }

    async fn get_json_from_candidates(
        &self,
        operation: &str,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<Value, String> {
        let mut errors = Vec::new();
        for (path, query) in attempts {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.get_json(path, query).await {
                Ok(value) => return Ok(value),
                Err(err) => errors.push(err),
            }
        }
        Err(format!("Failed to {operation}: {}", errors.join("; ")))
    }

    async fn submit_form_candidates(
        &self,
        operation: &str,
        method: reqwest::Method,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, form) in attempts {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.request(method.clone(), path, Vec::new(), Some(form), None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(_) => return Ok(()),
                    Err(err) => errors.push(err),
                },
                Err(err) => errors.push(err),
            }
        }
        Err(format!("Failed to {operation}: {}", errors.join("; ")))
    }

    async fn submit_query_candidates(
        &self,
        operation: &str,
        method: reqwest::Method,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, query) in attempts {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.request(method.clone(), path, query, None, None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(_) => return Ok(()),
                    Err(err) => errors.push(err),
                },
                Err(err) => errors.push(err),
            }
        }
        Err(format!("Failed to {operation}: {}", errors.join("; ")))
    }

    async fn get_service_json_from_candidates(
        &self,
        operation: &str,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<Value, String> {
        let mut errors = Vec::new();
        for (path, query) in attempts {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.get_json(path, query).await {
                Ok(value) => return Ok(value),
                Err(err) => {
                    let try_next = self.should_try_next_candidate(&err);
                    errors.push(err);
                    if !try_next {
                        break;
                    }
                }
            }
        }
        Err(format!("Failed to {operation}: {}", errors.join("; ")))
    }

    async fn submit_service_form_candidates(
        &self,
        operation: &str,
        method: reqwest::Method,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, form) in attempts {
            if !self.api_path_allowed(path) {
                continue;
            }
            let result = match self.request(method.clone(), path, Vec::new(), Some(form), None).await {
                Ok(resp) => error_for_status(resp, path).await.map(|_| ()),
                Err(err) => Err(err),
            };
            match result {
                Ok(()) => return Ok(()),
                Err(err) => {
                    let try_next = self.should_try_next_candidate(&err);
                    errors.push(err);
                    if !try_next {
                        break;
                    }
                }
            }
        }
        Err(format!("Failed to {operation}: {}", errors.join("; ")))
    }

    async fn submit_service_query_candidates(
        &self,
        operation: &str,
        method: reqwest::Method,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, query) in attempts {
            if !self.api_path_allowed(path) {
                continue;
            }
            let result = match self.request(method.clone(), path, query, None, None).await {
                Ok(resp) => error_for_status(resp, path).await.map(|_| ()),
                Err(err) => Err(err),
            };
            match result {
                Ok(()) => return Ok(()),
                Err(err) => {
                    let try_next = self.should_try_next_candidate(&err);
                    errors.push(err);
                    if !try_next {
                        break;
                    }
                }
            }
        }
        Err(format!("Failed to {operation}: {}", errors.join("; ")))
    }

    async fn submit_service_upsert(
        &self,
        operation: &str,
        req: NacosServiceUpsert,
        method: reqwest::Method,
    ) -> Result<(), String> {
        if req.service_name.trim().is_empty() {
            return Err("Nacos service name is required".to_string());
        }
        let group_name = req
            .group_name
            .as_deref()
            .map(str::trim)
            .filter(|group| !group.is_empty())
            .ok_or_else(|| "Nacos service group name is required".to_string())?
            .to_string();
        let namespace = self.namespace(req.namespace.as_deref());
        let mut form = vec![("namespaceId".to_string(), namespace), ("serviceName".to_string(), req.service_name)];
        form.push(("groupName".to_string(), group_name));
        if let Some(metadata) = req.metadata {
            if !metadata.is_object() {
                return Err("Nacos service metadata must be a JSON object".to_string());
            }
            form.push(("metadata".to_string(), metadata.to_string()));
        }
        if let Some(threshold) = req.protect_threshold {
            if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
                return Err("Nacos service protection threshold must be between 0 and 1".to_string());
            }
            form.push(("protectThreshold".to_string(), threshold.to_string()));
        }
        let selector = req.selector.unwrap_or_else(|| serde_json::json!({ "type": "none", "contextType": "NONE" }));
        if !selector.is_object() {
            return Err("Nacos service selector must be a JSON object".to_string());
        }
        // Both supported Nacos generations reject `{}`. DBX owns the
        // version-neutral "no selector" semantic and sends the canonical
        // none selector instead, which also allows an existing selector to be
        // cleared during an update.
        let selector = if selector.as_object().is_some_and(|object| object.is_empty()) {
            serde_json::json!({ "type": "none", "contextType": "NONE" })
        } else {
            selector
        };
        form.push(("selector".to_string(), selector.to_string()));
        if let Some(ephemeral) = req.ephemeral {
            form.push(("ephemeral".to_string(), ephemeral.to_string()));
        }
        self.submit_service_form_candidates(
            operation,
            method,
            vec![
                (self.v3_path("/v3/admin/ns/service", "/v3/console/ns/service"), form.clone()),
                // Nacos 2.x keeps the verified Naming management contract on
                // the v1 endpoint. The v2 compatibility endpoint can accept a
                // request while silently applying defaults to some fields.
                ("/v1/ns/service", form),
            ],
        )
        .await
    }

    async fn list_configs_by_client_filters(
        &self,
        namespace: String,
        data_id_filter: Option<String>,
        group_filter: Option<String>,
        app_name_filter: Option<String>,
        page_no: u32,
        page_size: u32,
    ) -> Result<NacosConfigList, String> {
        let data_id_filter = data_id_filter.map(|value| value.to_lowercase()).filter(|value| !value.is_empty());
        let group_filter = group_filter.map(|value| value.to_lowercase()).filter(|value| !value.is_empty());
        if data_id_filter.is_none() && group_filter.is_none() {
            return Ok(NacosConfigList { page_no, page_size, total_count: 0, items: Vec::new() });
        }
        let app_name = app_name_filter.unwrap_or_default();
        let scan_page_size = page_size.max(self.cfg.page_size).clamp(100, 500);
        let mut matched = Vec::new();
        let mut seen = HashSet::new();
        let mut current_page = 1;

        loop {
            let value = self.get_config_list_value(&namespace, "", "", &app_name, current_page, scan_page_size).await?;
            let list = parse_config_list(value, namespace.clone(), current_page, scan_page_size);
            let total_count = list.total_count;
            let empty = list.items.is_empty();
            let before = seen.len();
            for item in list.items {
                let identity = (item.namespace.clone(), item.group.clone(), item.data_id.clone());
                let data_id_matches =
                    data_id_filter.as_ref().is_none_or(|filter| item.data_id.to_lowercase().contains(filter));
                let group_matches =
                    group_filter.as_ref().is_none_or(|filter| item.group.to_lowercase().contains(filter));
                if seen.insert(identity) && data_id_matches && group_matches {
                    matched.push(item);
                }
            }

            if empty || total_count == 0 || seen.len() as u64 >= total_count {
                break;
            }
            if seen.len() == before {
                return Err("Nacos configuration pagination made no progress; the server repeated a page".to_string());
            }
            current_page = current_page
                .checked_add(1)
                .ok_or_else(|| "Nacos configuration pagination exceeded the supported page range".to_string())?;
        }

        let total_count = matched.len() as u64;
        let start = ((page_no.saturating_sub(1)) * page_size) as usize;
        let end = start.saturating_add(page_size as usize).min(matched.len());
        let items = if start < matched.len() { matched[start..end].to_vec() } else { Vec::new() };
        Ok(self.enrich_missing_config_formats(NacosConfigList { page_no, page_size, total_count, items }).await)
    }

    async fn enrich_missing_config_formats(&self, mut list: NacosConfigList) -> NacosConfigList {
        for item in list.items.iter_mut() {
            // Normal Nacos lists already carry descriptions when available.
            // r-nacos's compatibility list does not carry either the type or
            // description, and its configured console can supply both.
            // r-nacos list rows lack type/desc; load detail when a console is configured.
            let needs_rnacos_metadata = self.is_rnacos_compatible()
                && !self.cfg.rnacos_console_addr.is_empty()
                && (item.config_type.is_none() || item.desc.is_none());
            if item.config_type.is_some() && !needs_rnacos_metadata {
                continue;
            }
            let detail = self
                .get_config(NacosConfigKey {
                    namespace: Some(item.namespace.clone()),
                    data_id: item.data_id.clone(),
                    group: item.group.clone(),
                })
                .await;
            if let Ok(detail) = detail {
                if item.config_type.is_none() {
                    item.config_type = detail.config_type;
                }
                if item.desc.is_none() {
                    item.desc = detail.desc;
                }
            }
        }
        list
    }

    async fn list_v1_catalog_instances(
        &self,
        query: &NacosInstanceQuery,
        namespace: &str,
    ) -> Result<Vec<NacosInstanceInfo>, String> {
        // Nacos catalog controllers derive the group from serviceName and ignore a separate groupName parameter.
        let catalog_service_name = qualified_nacos_service_name(&query.service_name, query.group_name.as_deref());
        let mut cluster_names = split_nacos_cluster_names(query.clusters.as_deref());
        if cluster_names.is_empty() {
            let detail_params = vec![
                ("serviceName".to_string(), catalog_service_name.clone()),
                ("namespaceId".to_string(), namespace.to_string()),
            ];
            let detail = self.get_json("/v1/ns/catalog/service", detail_params).await?;
            cluster_names = parse_catalog_cluster_names(&detail);
        }

        let page_size = self.cfg.page_size.max(100).clamp(1, 500);
        let mut instances = Vec::new();
        for cluster_name in cluster_names {
            let mut page_no = 1u32;
            let mut loaded = 0u64;
            loop {
                let params = vec![
                    ("serviceName".to_string(), catalog_service_name.clone()),
                    ("namespaceId".to_string(), namespace.to_string()),
                    ("clusterName".to_string(), cluster_name.clone()),
                    ("pageNo".to_string(), page_no.to_string()),
                    ("pageSize".to_string(), page_size.to_string()),
                ];
                let value = self.get_json("/v1/ns/catalog/instances", params).await?;
                let total_count = catalog_instance_count(&value);
                let page = parse_instances(value);
                let page_len = page.len();
                loaded = loaded.saturating_add(page_len as u64);
                instances.extend(page);

                let has_more = total_count
                    .filter(|total| *total > 0)
                    .map(|total| loaded < total)
                    .unwrap_or(page_len == page_size as usize);
                if !has_more || page_len == 0 {
                    break;
                }
                page_no = page_no
                    .checked_add(1)
                    .ok_or_else(|| "Nacos instance pagination exceeded the supported page range".to_string())?;
            }
        }

        Ok(deduplicate_management_instances(instances, namespace, query.group_name.as_deref(), &query.service_name))
    }

    async fn list_v3_admin_instances(
        &self,
        query: &NacosInstanceQuery,
        namespace: &str,
    ) -> Result<Vec<NacosInstanceInfo>, String> {
        // Nacos 3's documentation says omitting `clusterName` lists every
        // cluster. Nacos 3.1.0 can instead resolve that omission to `DEFAULT`,
        // returning an error for services whose only cluster is, for example,
        // `blue` or lowercase `default`. Read the service's cluster map and
        // query every declared cluster explicitly. The same route also keeps
        // disabled instances visible for the management page.
        let requested_clusters = split_nacos_cluster_names(query.clusters.as_deref());
        let cluster_names = if requested_clusters.is_empty() {
            let mut detail_params = vec![
                ("namespaceId".to_string(), namespace.to_string()),
                ("serviceName".to_string(), query.service_name.clone()),
            ];
            push_optional(&mut detail_params, "groupName", query.group_name.clone());
            parse_catalog_cluster_names(
                &self.get_json(self.v3_path("/v3/admin/ns/service", "/v3/console/ns/service"), detail_params).await?,
            )
        } else {
            requested_clusters.clone()
        };

        // An empty cluster map is the normal state for an empty service. Do
        // not invent `DEFAULT` (which produces a misleading 404 on Nacos
        // 3.1), but also do not turn a valid zero-instance service into an
        // error: callers must still be able to inspect and delete it.
        if cluster_names.is_empty() {
            return Ok(Vec::new());
        }
        let mut instances = Vec::new();
        for cluster_name in cluster_names {
            let page_size = self.cfg.page_size.max(100).clamp(1, 500);
            let mut page_no = 1u32;
            let mut loaded = 0u64;
            loop {
                let mut params = vec![
                    ("namespaceId".to_string(), namespace.to_string()),
                    ("serviceName".to_string(), query.service_name.clone()),
                    ("clusterName".to_string(), cluster_name.clone()),
                ];
                push_optional(&mut params, "groupName", query.group_name.clone());
                if self.is_v3_console() {
                    params.push(("pageNo".to_string(), page_no.to_string()));
                    params.push(("pageSize".to_string(), page_size.to_string()));
                    params.push(("enabledOnly".to_string(), "false".to_string()));
                }
                let value = self
                    .get_json(self.v3_path("/v3/admin/ns/instance/list", "/v3/console/ns/instance/list"), params)
                    .await?;
                let total_count = catalog_instance_count(&value);
                let page = parse_instances(value);
                let page_len = page.len();
                loaded = loaded.saturating_add(page_len as u64);
                instances.extend(page);
                if !self.is_v3_console()
                    || page_len == 0
                    || total_count.map(|total| loaded >= total).unwrap_or(page_len < page_size as usize)
                {
                    break;
                }
                page_no = page_no
                    .checked_add(1)
                    .ok_or_else(|| "Nacos instance pagination exceeded the supported page range".to_string())?;
            }
        }
        Ok(filter_instances_by_clusters(
            deduplicate_management_instances(instances, namespace, query.group_name.as_deref(), &query.service_name),
            &requested_clusters,
        ))
    }

    async fn verify_v3_naming_admin_api(&self, namespace: &str) -> Result<(), String> {
        self.get_json(
            self.v3_path("/v3/admin/ns/service/list", "/v3/console/ns/service/list"),
            vec![
                ("namespaceId".to_string(), namespace.to_string()),
                ("pageNo".to_string(), "1".to_string()),
                ("pageSize".to_string(), "1".to_string()),
            ],
        )
        .await?;
        Ok(())
    }

    async fn verify_v3_admin_config_api(&self, namespace: &str) -> Result<(), String> {
        self.get_json(
            self.v3_path("/v3/admin/cs/config/list", "/v3/console/cs/config/list"),
            vec![
                ("namespaceId".to_string(), namespace.to_string()),
                ("dataId".to_string(), String::new()),
                ("groupName".to_string(), String::new()),
                ("configDetail".to_string(), String::new()),
                ("search".to_string(), "blur".to_string()),
                ("pageNo".to_string(), "1".to_string()),
                ("pageSize".to_string(), "1".to_string()),
            ],
        )
        .await?;
        Ok(())
    }

    async fn verify_v3_managed_namespaces(&self, namespaces: &[NacosNamespaceInfo]) -> Result<(), String> {
        let mut errors = Vec::new();
        for namespace in namespaces {
            let namespace_id = &namespace.namespace;
            let naming_result = self.verify_v3_naming_admin_api(namespace_id).await;
            let config_result = self.verify_v3_admin_config_api(namespace_id).await;
            if let Err(error) = naming_result {
                errors.push(format!("namespace {namespace_id:?} naming: {error}"));
            }
            if let Err(error) = config_result {
                errors.push(format!("namespace {namespace_id:?} config: {error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(classified_error(
                "managedNamespaceAccessDenied",
                &format!("One or more configured namespace IDs are not readable: {}", errors.join("; ")),
            ))
        }
    }

    async fn verify_v2_managed_namespaces(&self, namespaces: &[NacosNamespaceInfo]) -> Result<(), String> {
        let mut errors = Vec::new();
        for namespace in namespaces {
            let namespace_id = &namespace.namespace;
            if let Err(error) = self.get_config_list_value(namespace_id, "", "", "", 1, 1).await {
                errors.push(format!("namespace {namespace_id:?} config: {error}"));
            }
            let params = vec![
                ("namespaceId".to_string(), namespace_id.clone()),
                ("pageNo".to_string(), "1".to_string()),
                ("pageSize".to_string(), "1".to_string()),
            ];
            if let Err(error) = self
                .get_service_json_from_candidates(
                    "validate Nacos v2 namespace service access",
                    vec![("/v1/ns/catalog/services", params.clone()), ("/v2/ns/service/list", params)],
                )
                .await
            {
                errors.push(format!("namespace {namespace_id:?} naming: {error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(classified_error(
                "managedNamespaceAccessDenied",
                &format!("One or more configured namespace IDs are not readable: {}", errors.join("; ")),
            ))
        }
    }

    fn map_v3_verification_error(error: String) -> String {
        if error.contains("[contextPathMismatch]") || error.contains("[apiVersionMismatch]") {
            format!(
                "NACOS_ERROR[v3EndpointMismatch]: {error}. 请检查所选 Nacos 3 API 模式、服务地址和上下文路径是否匹配。"
            )
        } else {
            error
        }
    }

    fn baseline_access_control_capabilities(&self) -> NacosAccessControlCapabilities {
        if self.is_rnacos_compatible() {
            if self.cfg.rnacos_console_addr.trim().is_empty() || !self.cfg.has_effective_rnacos_console_credentials() {
                return NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::EndpointUnavailable);
            }
            return NacosAccessControlCapabilities {
                mode: NacosAccessControlMode::EmbeddedRoles,
                list_users: NacosOperationCapability::supported(),
                create_user: NacosOperationCapability::supported(),
                update_user: NacosOperationCapability::supported(),
                delete_user: NacosOperationCapability::supported(),
                list_role_bindings: NacosOperationCapability::unsupported(NacosCapabilityReason::VersionUnsupported),
                assign_role: NacosOperationCapability::unsupported(NacosCapabilityReason::VersionUnsupported),
                remove_role: NacosOperationCapability::unsupported(NacosCapabilityReason::VersionUnsupported),
                list_permissions: NacosOperationCapability::unsupported(NacosCapabilityReason::VersionUnsupported),
                grant_permission: NacosOperationCapability::unsupported(NacosCapabilityReason::VersionUnsupported),
                revoke_permission: NacosOperationCapability::unsupported(NacosCapabilityReason::VersionUnsupported),
                enhanced_workspace: false,
                supports_namespace_privileges: true,
            };
        }
        if matches!(self.cfg.auth, NacosAuthConfig::None) {
            official_full_access_control()
        } else {
            official_unverified_access_control()
        }
    }

    fn cached_access_control_capabilities(&self) -> Option<NacosAccessControlCapabilities> {
        self.access_control_capabilities
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .filter(|cached| cached.expires_at > Instant::now())
            .map(|cached| cached.capabilities.clone())
    }

    fn store_access_control_capabilities(
        &self,
        capabilities: NacosAccessControlCapabilities,
        authorization: Option<CachedOfficialAuthorization>,
    ) {
        *self.access_control_capabilities.write().unwrap_or_else(|error| error.into_inner()) =
            Some(CachedAccessControlCapabilities {
                capabilities,
                authorization,
                expires_at: Instant::now() + ACCESS_CONTROL_CAPABILITY_CACHE_TTL,
            });
    }

    fn cached_official_authorization(&self, username: &str) -> Option<CachedOfficialAuthorization> {
        self.access_control_capabilities
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .filter(|cached| cached.expires_at > Instant::now())
            .and_then(|cached| cached.authorization.as_ref())
            .filter(|authorization| authorization.username == username)
            .cloned()
    }

    fn console_write_granted(permissions: &[NacosPermissionInfo], roles: &HashSet<String>, resource: &str) -> bool {
        permissions.iter().any(|permission| {
            roles.contains(&permission.role)
                && permission.resource_raw.trim().eq_ignore_ascii_case(resource)
                && matches!(permission.action_raw.trim().to_ascii_lowercase().as_str(), "w" | "rw" | "wr" | "*")
        })
    }

    async fn probe_access_control_capabilities(&self) -> NacosAccessControlCapabilities {
        if let Some(capabilities) = self.cached_access_control_capabilities() {
            return capabilities;
        }
        if self.explicitly_scoped_namespace_ids().is_some() {
            let capabilities = NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::PermissionDenied);
            self.store_access_control_capabilities(capabilities.clone(), None);
            return capabilities;
        }
        let baseline = self.baseline_access_control_capabilities();
        if self.is_rnacos_compatible() || matches!(self.cfg.auth, NacosAuthConfig::None) {
            self.store_access_control_capabilities(baseline.clone(), None);
            return baseline;
        }
        let Some(username) = self.current_username() else {
            self.store_access_control_capabilities(baseline.clone(), None);
            return baseline;
        };

        let users = self
            .list_users(NacosUserQuery { username: Some(username.clone()), page_no: Some(1), page_size: Some(1) })
            .await;
        let role_bindings = self
            .list_role_bindings(NacosRoleQuery {
                username: Some(username.clone()),
                role: None,
                page_no: Some(1),
                page_size: Some(ACCESS_CONTROL_PROBE_PAGE_SIZE),
            })
            .await;
        let permissions = self
            .list_permissions(NacosPermissionQuery {
                role: None,
                resource: None,
                page_no: Some(1),
                page_size: Some(ACCESS_CONTROL_PROBE_PAGE_SIZE),
            })
            .await;

        let list_users = read_capability(&users);
        let list_role_bindings = read_capability(&role_bindings);
        let list_permissions = read_capability(&permissions);
        let roles = role_bindings
            .as_ref()
            .map(|page| {
                page.items
                    .iter()
                    .filter(|binding| binding.username == username)
                    .map(|binding| binding.role.clone())
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        let global_admin = self.global_admin.load(Ordering::Relaxed) == 2 || roles.contains(ADMIN_ROLE);
        let authorization_complete = global_admin
            || role_bindings.as_ref().is_ok_and(|page| page.total_count <= page.items.len() as u64)
                && permissions.as_ref().is_ok_and(|page| page.total_count <= page.items.len() as u64);
        let permission_items = permissions.as_ref().map(|page| page.items.as_slice()).unwrap_or_default();
        let users_write = global_admin || Self::console_write_granted(permission_items, &roles, CONSOLE_USERS_RESOURCE);
        let roles_write = global_admin || Self::console_write_granted(permission_items, &roles, CONSOLE_ROLES_RESOURCE);
        let permissions_write =
            global_admin || Self::console_write_granted(permission_items, &roles, CONSOLE_PERMISSIONS_RESOURCE);
        let create_user = write_capability(&list_users, authorization_complete, users_write);
        let update_user = create_user.clone();
        let delete_user = create_user.clone();
        let assign_role = write_capability(&list_role_bindings, authorization_complete, roles_write);
        let remove_role = assign_role.clone();
        let grant_permission = write_capability(&list_permissions, authorization_complete, permissions_write);
        let revoke_permission = grant_permission.clone();
        // The directory-detail workspace is a read surface. Individual
        // mutations are guarded separately so a read-only or partially
        // privileged administrator can still inspect the data it may read.
        let enhanced_workspace =
            [&list_users, &list_role_bindings, &list_permissions].into_iter().all(|capability| capability.supported);
        let capabilities = NacosAccessControlCapabilities {
            mode: NacosAccessControlMode::RoleBindings,
            list_users,
            create_user,
            update_user,
            delete_user,
            list_role_bindings,
            assign_role,
            remove_role,
            list_permissions,
            grant_permission,
            revoke_permission,
            enhanced_workspace,
            supports_namespace_privileges: false,
        };
        self.store_access_control_capabilities(
            capabilities.clone(),
            Some(CachedOfficialAuthorization { username, role_bindings, permissions }),
        );
        capabilities
    }

    async fn complete_role_bindings_page(
        &self,
        username: &str,
        first_page: NacosRoleList,
    ) -> Result<Vec<NacosRoleBinding>, String> {
        let mut items = first_page.items;
        let total_count = first_page.total_count;
        let page_size = first_page.page_size.max(1);
        let mut page_no = first_page.page_no.max(1);
        while (items.len() as u64) < total_count {
            page_no += 1;
            let page = self
                .list_role_bindings(NacosRoleQuery {
                    username: Some(username.to_string()),
                    role: None,
                    page_no: Some(page_no),
                    page_size: Some(page_size),
                })
                .await?;
            let count = page.items.len();
            items.extend(page.items);
            if count < page_size as usize {
                break;
            }
        }
        Ok(items)
    }

    async fn complete_permissions_page(
        &self,
        first_page: NacosPermissionList,
    ) -> Result<Vec<NacosPermissionInfo>, String> {
        let mut items = first_page.items;
        let total_count = first_page.total_count;
        let page_size = first_page.page_size.max(1);
        let mut page_no = first_page.page_no.max(1);
        while (items.len() as u64) < total_count {
            page_no += 1;
            let page = self
                .list_permissions(NacosPermissionQuery {
                    role: None,
                    resource: None,
                    page_no: Some(page_no),
                    page_size: Some(page_size),
                })
                .await?;
            let count = page.items.len();
            items.extend(page.items);
            if count < page_size as usize {
                break;
            }
        }
        Ok(items)
    }

    async fn update_v3_admin_instance(&self, req: NacosInstanceUpdateRequest) -> Result<(), String> {
        let namespace = self.namespace(req.target.namespace.as_deref());
        // Nacos v3 exposes a dedicated partial-update endpoint. Send only the
        // target identity and fields present in the patch so an external
        // console update cannot be overwritten by a stale read-modify-write.
        let form = instance_update_form(namespace, req);
        let response = self
            .request(
                reqwest::Method::PUT,
                self.v3_path("/v3/admin/ns/instance/partial", "/v3/console/ns/instance"),
                Vec::new(),
                Some(form),
                None,
            )
            .await?;
        error_for_status(response, self.v3_path("/v3/admin/ns/instance/partial", "/v3/console/ns/instance")).await?;
        Ok(())
    }

    async fn get_dashboard_nodes(&self) -> Result<Vec<NacosClusterNode>, String> {
        // r-nacos does not implement the official Nacos cluster-node Admin
        // APIs. An empty list represents this unsupported optional capability
        // without turning every dashboard refresh into a false warning.
        if self.is_rnacos_compatible() {
            return Ok(Vec::new());
        }

        self.get_json_from_candidates(
            "load Nacos cluster nodes",
            vec![
                (self.v3_path("/v3/admin/core/cluster/node/list", "/v3/console/core/cluster/nodes"), Vec::new()),
                ("/v2/core/cluster/node/list", Vec::new()),
                ("/v1/core/cluster/nodes", Vec::new()),
                ("/v1/ns/operator/servers", Vec::new()),
            ],
        )
        .await
        .map(parse_cluster_nodes)
    }

    fn dashboard_warning(&self, error: String) -> String {
        if matches!(self.cfg.version_mode, Some(NacosVersionMode::V3))
            && (error.contains("[contextPathMismatch]") || error.contains("[apiVersionMismatch]"))
        {
            let endpoint = if self.is_v3_console() {
                "the Console API endpoint (normally http://host:8080)"
            } else {
                "the Server / Admin API endpoint (normally http://host:8848/nacos)"
            };
            return format!("{error} Check that the connection address and context path match {endpoint}.");
        }
        error
    }
}

fn qualified_nacos_service_name(service_name: &str, group_name: Option<&str>) -> String {
    match group_name.map(str::trim).filter(|group| !group.is_empty()) {
        Some(group) => format!("{group}@@{service_name}"),
        None => service_name.to_string(),
    }
}

fn content_search_endpoint_is_unsupported(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("returned 404")
        || lower.contains("returned 405")
        || lower.contains("returned 410")
        // Spring-based gateways and some Nacos distributions wrap an
        // unmapped admin route as HTTP 500 instead of returning 404.
        || lower.contains("no static resource")
        || lower.contains("unsupported content search")
        || lower.contains("unsupportedcontentsearch")
}

#[async_trait]
impl NacosAdmin for NacosOpenApiAdmin {
    fn service_capabilities(&self) -> NacosServiceCapabilities {
        // r-nacos 0.8.x documents the full compatible v1 Naming management
        // surface: service POST/PUT/DELETE and instance POST/PUT/PATCH/DELETE.
        // Its own console exercises the same operations. `api_path_allowed`
        // keeps these calls strictly on `/v1/ns/...`, never on Nacos v3 admin
        // routes, so the shared UI can expose the verified CRUD workflow.
        let mut capabilities = NacosServiceCapabilities::default();
        if self.is_official_v3() {
            capabilities.update_instance_health =
                NacosOperationCapability::unsupported(NacosCapabilityReason::EndpointUnavailable);
        }
        if self.is_v3_console() {
            capabilities.register_instance =
                NacosOperationCapability::unsupported(NacosCapabilityReason::EndpointUnavailable);
            capabilities.deregister_instance =
                NacosOperationCapability::unsupported(NacosCapabilityReason::EndpointUnavailable);
        }
        if self.is_rnacos_compatible() && self.cfg.rnacos_console_addr.trim().is_empty() {
            // r-nacos's compatible discovery API hides disabled instances.
            // Without its console API, DBX cannot safely prove a service is
            // empty before deletion, so keep this destructive action closed.
            capabilities.delete_service =
                NacosOperationCapability::unsupported(NacosCapabilityReason::EndpointUnavailable);
        }
        capabilities
    }

    fn access_control_capabilities(&self) -> NacosAccessControlCapabilities {
        self.cached_access_control_capabilities().unwrap_or_else(|| self.baseline_access_control_capabilities())
    }

    fn invalidate_access_control_capabilities(&self) {
        *self.access_control_capabilities.write().unwrap_or_else(|error| error.into_inner()) = None;
    }

    fn current_username(&self) -> Option<String> {
        match &self.cfg.auth {
            crate::nacos::config::NacosAuthConfig::UsernamePassword { username, .. } => {
                let username = username.trim();
                (!username.is_empty()).then(|| username.to_string())
            }
            crate::nacos::config::NacosAuthConfig::None => None,
        }
    }

    fn explicitly_scoped_namespace_ids(&self) -> Option<Vec<String>> {
        (!self.is_explicit_rnacos()
            && matches!(self.cfg.auth, NacosAuthConfig::UsernamePassword { .. })
            && !self.cfg.managed_namespaces.is_empty())
        .then(|| self.cfg.managed_namespaces.clone())
    }

    async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
        // Server-state endpoints are console APIs and r-nacos deliberately only
        // guarantees the client OpenAPI. Treat state/health as best-effort;
        // successful authentication and namespace access below prove that this
        // connection can perform the DBX operations it exposes.
        let state = self.get_server_state().await.ok();
        // Namespace discovery must use r-nacos' compatible v1 API as soon as
        // its health response identifies the implementation. Delaying this
        // assignment until after `list_namespaces` made a fresh r-nacos
        // connection first probe official Nacos v3 routes.
        let is_rnacos = self.is_explicit_rnacos() || state.as_ref().is_some_and(|state| state.is_rnacos_compatible);
        self.detected_rnacos.store(is_rnacos, Ordering::Relaxed);
        let _ = self.access_token().await?;
        if let Err(error) = self.list_namespaces().await {
            // r-nacos can authenticate and serve configuration reads without
            // exposing a namespace directory. The connection dialog will
            // collect an explicit display scope instead of rejecting this
            // otherwise valid OpenAPI connection.
            if !(is_rnacos && error.contains("NACOS_ERROR[rnacosNamespaceDirectoryUnavailable]")) {
                return Err(error);
            }
        }
        let mut capabilities =
            NacosCapabilities { service_management: self.service_capabilities(), ..Default::default() };
        if is_rnacos {
            if !self.cfg.rnacos_history_enabled() {
                capabilities.supports_config_history = false;
                capabilities.history_unavailable_reason = Some("historyDisabled".to_string());
            } else if self.cfg.rnacos_console_addr.is_empty() {
                capabilities.supports_config_history = false;
                capabilities.history_unavailable_reason = Some("consoleUrlMissing".to_string());
            } else if !self.cfg.has_effective_rnacos_console_credentials() {
                capabilities.supports_config_history = false;
                capabilities.history_unavailable_reason = Some("consoleCredentialsMissing".to_string());
            }
        }
        let access_control = if self.explicitly_scoped_namespace_ids().is_some() {
            NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::PermissionDenied)
        } else {
            self.access_control_capabilities()
        };
        capabilities.access_control = access_control;
        capabilities.supports_service_management = capabilities.service_management.list_services.supported;
        capabilities.supports_instance_update = capabilities.service_management.update_instance.supported;
        let server_version = if is_rnacos {
            self.rnacos_console_version_if_authenticated().await
        } else {
            state.as_ref().and_then(|state| extract_server_version(&state.raw))
        };
        let is_v3 = matches!(self.cfg.version_mode, Some(NacosVersionMode::V3));
        if !is_rnacos && is_v3 && self.is_v3_console() {
            capabilities.supports_raw_api = false;
        }
        if !is_rnacos && is_v3 && !self.cfg.managed_namespaces.is_empty() {
            // A namespace directory can include entries that an ordinary user
            // is not allowed to open. With no user-selected scope, validating
            // the first entry (commonly `public`) rejects the connection before
            // the explicit access picker can probe every namespace. Explicit
            // scopes remain strictly validated below.
            let representative = NacosNamespaceInfo {
                namespace: self.cfg.managed_namespaces[0].clone(),
                namespace_show_name: self.cfg.managed_namespaces[0].clone(),
                namespace_desc: None,
                config_count: None,
                quota: None,
                namespace_type: None,
            };
            let verification = self.verify_v3_managed_namespaces(std::slice::from_ref(&representative)).await;
            verification.map_err(Self::map_v3_verification_error)?;
        }
        Ok(NacosConnectionInfo {
            server_addr: self.cfg.server_addr.clone(),
            display_server_addr: self.cfg.display_server_addr.clone(),
            namespace: self.cfg.namespace.clone(),
            server_version,
            auth: match self.cfg.auth {
                NacosAuthConfig::None => "none".to_string(),
                NacosAuthConfig::UsernamePassword { .. } => "usernamePassword".to_string(),
            },
            capabilities,
            raw: state.map(|state| state.raw),
        })
    }

    async fn test_connection_with_scope_validation(&self) -> Result<NacosConnectionInfo, String> {
        let info = self.test_connection().await?;
        if self.is_rnacos_compatible() || self.cfg.managed_namespaces.is_empty() {
            return Ok(info);
        }
        if matches!(self.cfg.version_mode, Some(NacosVersionMode::V3)) {
            // The bounded regular check already validated the first configured
            // namespace. The explicit check completes the remainder without
            // repeating that pair of requests.
            let managed_namespaces = self
                .cfg
                .managed_namespaces
                .iter()
                .skip(1)
                .map(|namespace| NacosNamespaceInfo {
                    namespace: namespace.clone(),
                    namespace_show_name: namespace.clone(),
                    namespace_desc: None,
                    config_count: None,
                    quota: None,
                    namespace_type: None,
                })
                .collect::<Vec<_>>();
            if !managed_namespaces.is_empty() {
                self.verify_v3_managed_namespaces(&managed_namespaces)
                    .await
                    .map_err(Self::map_v3_verification_error)?;
            }
        } else if matches!(self.cfg.version_mode, Some(NacosVersionMode::V2)) {
            let managed_namespaces = self
                .cfg
                .managed_namespaces
                .iter()
                .map(|namespace| NacosNamespaceInfo {
                    namespace: namespace.clone(),
                    namespace_show_name: namespace.clone(),
                    namespace_desc: None,
                    config_count: None,
                    quota: None,
                    namespace_type: None,
                })
                .collect::<Vec<_>>();
            self.verify_v2_managed_namespaces(&managed_namespaces).await?;
        }
        Ok(info)
    }

    async fn refresh_access_control_capabilities(&self) -> NacosAccessControlCapabilities {
        self.probe_access_control_capabilities().await
    }

    async fn refresh_namespace_authorization(
        &self,
        username: &str,
    ) -> Result<Option<NacosNamespaceAuthorizationSnapshot>, String> {
        let access_control = self.probe_access_control_capabilities().await;
        let Some(authorization) = self.cached_official_authorization(username) else {
            return Ok(None);
        };
        let login_global_admin = self.global_admin.load(Ordering::Relaxed) == 2;
        if login_global_admin {
            return Ok(Some(NacosNamespaceAuthorizationSnapshot {
                access_control,
                roles: vec![ADMIN_ROLE.to_string()],
                permissions: Vec::new(),
                global_admin: true,
            }));
        }

        let role_bindings = self.complete_role_bindings_page(username, authorization.role_bindings?).await?;
        let mut roles = role_bindings
            .into_iter()
            .filter(|binding| binding.username == username)
            .map(|binding| binding.role)
            .collect::<Vec<_>>();
        roles.sort();
        roles.dedup();
        let global_admin = roles.iter().any(|role| role == ADMIN_ROLE);
        let permissions =
            if global_admin { Vec::new() } else { self.complete_permissions_page(authorization.permissions?).await? };
        Ok(Some(NacosNamespaceAuthorizationSnapshot { access_control, roles, permissions, global_admin }))
    }

    async fn inspect_connection(&self) -> Result<NacosConnectionInfo, String> {
        let mut info = self.test_connection().await?;
        info.capabilities.access_control = self.probe_access_control_capabilities().await;
        Ok(info)
    }

    async fn get_rnacos_console_captcha(&self) -> Result<NacosRNacosConsoleCaptcha, String> {
        self.fetch_rnacos_console_captcha().await
    }

    async fn login_rnacos_console(&self, captcha: Option<String>) -> Result<(), String> {
        self.login_rnacos_console_with_captcha(captcha).await.map(|_| ())
    }

    async fn list_users(&self, query: NacosUserQuery) -> Result<NacosUserList, String> {
        let page_no = query.page_no.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(self.cfg.page_size).clamp(1, 500);
        let username = query.username.unwrap_or_default().trim().to_string();
        if self.is_rnacos_compatible() {
            let value = self
                .get_rnacos_console_json(
                    "/rnacos/api/console/v2/user/list",
                    vec![
                        ("likeUsername".to_string(), username),
                        ("pageNo".to_string(), page_no.to_string()),
                        ("pageSize".to_string(), page_size.to_string()),
                        ("isRev".to_string(), "false".to_string()),
                    ],
                )
                .await?;
            return Ok(parse_user_list(value, page_no, page_size));
        }
        let value = self
            .get_json_from_candidates(
                "list Nacos users",
                vec![
                    (
                        "/v3/auth/user/list",
                        vec![
                            ("pageNo".to_string(), page_no.to_string()),
                            ("pageSize".to_string(), page_size.to_string()),
                            ("username".to_string(), username.clone()),
                            ("search".to_string(), "blur".to_string()),
                        ],
                    ),
                    (
                        "/v1/auth/users",
                        vec![
                            ("pageNo".to_string(), page_no.to_string()),
                            ("pageSize".to_string(), page_size.to_string()),
                            ("username".to_string(), username),
                            ("search".to_string(), "blur".to_string()),
                        ],
                    ),
                ],
            )
            .await?;
        Ok(parse_user_list(value, page_no, page_size))
    }

    async fn create_user(&self, req: NacosUserCreate) -> Result<(), String> {
        let username = validated_nacos_username(&req.username)?;
        if req.password.is_empty() {
            return Err(classified_error("invalidUser", "Nacos user password is required"));
        }
        if self.is_rnacos_compatible() {
            self.post_rnacos_console_json(
                "/rnacos/api/console/v2/user/add",
                rnacos_user_payload(
                    &username,
                    Some(&req.password),
                    req.nickname.as_deref(),
                    req.enabled,
                    Some(&req.roles),
                    req.namespace_privilege.as_ref(),
                    true,
                ),
            )
            .await?;
            return Ok(());
        }
        self.submit_form_candidates(
            "create Nacos user",
            reqwest::Method::POST,
            vec![
                (
                    "/v3/auth/user",
                    vec![("username".to_string(), username.clone()), ("password".to_string(), req.password.clone())],
                ),
                ("/v1/auth/users", vec![("username".to_string(), username), ("password".to_string(), req.password)]),
            ],
        )
        .await
    }

    async fn update_user(&self, req: NacosUserUpdate) -> Result<(), String> {
        let username = validated_nacos_username(&req.username)?;
        if self.is_rnacos_compatible() {
            self.post_rnacos_console_json(
                "/rnacos/api/console/v2/user/update",
                rnacos_user_payload(
                    &username,
                    req.password.as_deref(),
                    req.nickname.as_deref(),
                    req.enabled,
                    req.roles.as_deref(),
                    req.namespace_privilege.as_ref(),
                    false,
                ),
            )
            .await?;
            return Ok(());
        }
        let password = req
            .password
            .filter(|value| !value.is_empty())
            .ok_or_else(|| classified_error("invalidUser", "A new password is required when updating a Nacos user"))?;
        let attempts = vec![
            (
                "/v3/auth/user",
                vec![("username".to_string(), username.clone()), ("newPassword".to_string(), password.clone())],
            ),
            ("/v1/auth/users", vec![("username".to_string(), username), ("newPassword".to_string(), password)]),
        ];
        let result =
            self.submit_form_candidates("update Nacos user password", reqwest::Method::PUT, attempts.clone()).await;
        if !matches!(&result, Err(error) if is_official_session_expired(error)) {
            return result;
        }

        *self.token.lock().await = None;
        self.global_admin.store(0, Ordering::Relaxed);
        self.invalidate_access_control_capabilities();
        self.submit_form_candidates("update Nacos user password", reqwest::Method::PUT, attempts).await
    }

    async fn delete_user(&self, username: String) -> Result<(), String> {
        let username = validated_nacos_username(&username)?;
        if self.is_rnacos_compatible() {
            self.post_rnacos_console_json(
                "/rnacos/api/console/v2/user/remove",
                serde_json::json!({ "username": username }),
            )
            .await?;
            return Ok(());
        }
        self.submit_query_candidates(
            "delete Nacos user",
            reqwest::Method::DELETE,
            vec![
                ("/v3/auth/user", vec![("username".to_string(), username.clone())]),
                ("/v1/auth/users", vec![("username".to_string(), username)]),
            ],
        )
        .await
    }

    async fn list_role_bindings(&self, query: NacosRoleQuery) -> Result<NacosRoleList, String> {
        if self.is_rnacos_compatible() {
            return Err(classified_error(
                "unsupportedOperation",
                "r-nacos stores fixed roles on each user instead of exposing role bindings",
            ));
        }
        let page_no = query.page_no.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(self.cfg.page_size).clamp(1, 500);
        let username = query.username.unwrap_or_default().trim().to_string();
        let role = query.role.unwrap_or_default().trim().to_string();
        let value = self
            .get_json_from_candidates(
                "list Nacos role bindings",
                vec![
                    (
                        "/v3/auth/role/list",
                        vec![
                            ("pageNo".to_string(), page_no.to_string()),
                            ("pageSize".to_string(), page_size.to_string()),
                            ("username".to_string(), username.clone()),
                            ("role".to_string(), role.clone()),
                            ("search".to_string(), "blur".to_string()),
                        ],
                    ),
                    (
                        "/v1/auth/roles",
                        vec![
                            ("pageNo".to_string(), page_no.to_string()),
                            ("pageSize".to_string(), page_size.to_string()),
                            ("username".to_string(), username),
                            ("role".to_string(), role),
                            ("search".to_string(), "blur".to_string()),
                        ],
                    ),
                ],
            )
            .await?;
        Ok(parse_role_list(value, page_no, page_size))
    }

    async fn assign_role(&self, binding: NacosRoleBinding) -> Result<(), String> {
        let username = validated_nacos_username(&binding.username)?;
        let role = validated_nacos_role(&binding.role)?;
        if self.is_rnacos_compatible() {
            return Err(classified_error("unsupportedOperation", "r-nacos roles are updated with the user record"));
        }
        self.submit_form_candidates(
            "assign Nacos role",
            reqwest::Method::POST,
            vec![
                ("/v3/auth/role", vec![("username".to_string(), username.clone()), ("role".to_string(), role.clone())]),
                ("/v1/auth/roles", vec![("username".to_string(), username), ("role".to_string(), role)]),
            ],
        )
        .await
    }

    async fn remove_role(&self, binding: NacosRoleBinding) -> Result<(), String> {
        let username = validated_nacos_username(&binding.username)?;
        let role = validated_nacos_role(&binding.role)?;
        if self.is_rnacos_compatible() {
            return Err(classified_error("unsupportedOperation", "r-nacos roles are updated with the user record"));
        }
        // Both Nacos generations interpret an omitted username as "remove every
        // binding for this role". Always send the pair represented by the UI row.
        self.submit_query_candidates(
            "remove Nacos role binding",
            reqwest::Method::DELETE,
            vec![
                ("/v3/auth/role", vec![("username".to_string(), username.clone()), ("role".to_string(), role.clone())]),
                ("/v1/auth/roles", vec![("username".to_string(), username), ("role".to_string(), role)]),
            ],
        )
        .await
    }

    async fn list_permissions(&self, query: NacosPermissionQuery) -> Result<NacosPermissionList, String> {
        if self.is_rnacos_compatible() {
            return Err(classified_error("unsupportedOperation", "r-nacos does not expose Nacos role permissions"));
        }
        let page_no = query.page_no.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(self.cfg.page_size).clamp(1, 500);
        let role = query.role.unwrap_or_default().trim().to_string();
        let resource = query.resource.unwrap_or_default().trim().to_string();
        let value = self
            .get_json_from_candidates(
                "list Nacos permissions",
                vec![
                    (
                        "/v3/auth/permission/list",
                        vec![
                            ("pageNo".to_string(), page_no.to_string()),
                            ("pageSize".to_string(), page_size.to_string()),
                            ("role".to_string(), role.clone()),
                            ("resource".to_string(), resource.clone()),
                            ("search".to_string(), "blur".to_string()),
                        ],
                    ),
                    (
                        "/v1/auth/permissions",
                        vec![
                            ("pageNo".to_string(), page_no.to_string()),
                            ("pageSize".to_string(), page_size.to_string()),
                            ("role".to_string(), role),
                            ("resource".to_string(), resource),
                            ("search".to_string(), "blur".to_string()),
                        ],
                    ),
                ],
            )
            .await?;
        Ok(parse_permission_list(value, page_no, page_size))
    }

    async fn grant_permission(&self, permission: NacosPermissionInfo) -> Result<(), String> {
        let role = validated_nacos_role(&permission.role)?;
        let resource = permission.resource_raw.trim().to_string();
        let action = validated_nacos_permission_action(&permission.action_raw)?;
        if resource.is_empty() {
            return Err(classified_error("invalidPermission", "Nacos permission resource is required"));
        }
        self.submit_form_candidates(
            "grant Nacos permission",
            reqwest::Method::POST,
            vec![
                (
                    "/v3/auth/permission",
                    vec![
                        ("role".to_string(), role.clone()),
                        ("resource".to_string(), resource.clone()),
                        ("action".to_string(), action.clone()),
                    ],
                ),
                (
                    "/v1/auth/permissions",
                    vec![
                        ("role".to_string(), role),
                        ("resource".to_string(), resource),
                        ("action".to_string(), action),
                    ],
                ),
            ],
        )
        .await
    }

    async fn revoke_permission(&self, permission: NacosPermissionInfo) -> Result<(), String> {
        let role = validated_nacos_role(&permission.role)?;
        let resource = permission.resource_raw.trim().to_string();
        let action = permission.action_raw.trim().to_string();
        if resource.is_empty() || action.is_empty() {
            return Err(classified_error("invalidPermission", "Nacos permission resource and action are required"));
        }
        self.submit_query_candidates(
            "revoke Nacos permission",
            reqwest::Method::DELETE,
            vec![
                (
                    "/v3/auth/permission",
                    vec![
                        ("role".to_string(), role.clone()),
                        ("resource".to_string(), resource.clone()),
                        ("action".to_string(), action.clone()),
                    ],
                ),
                (
                    "/v1/auth/permissions",
                    vec![
                        ("role".to_string(), role),
                        ("resource".to_string(), resource),
                        ("action".to_string(), action),
                    ],
                ),
            ],
        )
        .await
    }

    async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
        if self.is_rnacos_compatible() {
            // Namespace discovery is not part of r-nacos' client OpenAPI
            // contract. Do not turn a failed optional console login into a
            // prerequisite for normal OpenAPI configuration access: console
            // deployments can require CAPTCHA, OAuth, or different credentials.
            // The caller can still use an explicitly configured namespace
            // scope, whose individual config requests remain server-authorized.
            match self.get_json("/v1/console/namespaces", Vec::new()).await {
                Ok(value) => return Ok(parse_namespaces(value)),
                Err(openapi_error) if rnacos_namespace_directory_endpoint_unavailable(&openapi_error) => {
                    return Err(classified_error(
                        "rnacosNamespaceDirectoryUnavailable",
                        &format!(
                            "r-nacos could not list namespaces through its OpenAPI endpoint: {openapi_error}. Configure the namespace IDs to display instead of relying on console authentication"
                        ),
                    ));
                }
                // A reachable endpoint that rejects the current API token, or
                // a transport/server failure, is not evidence that the
                // directory is optional. Propagate it so connection testing
                // cannot report success for an unusable OpenAPI session.
                Err(openapi_error) => return Err(openapi_error),
            }
        }
        match self
            .get_json_from_candidates(
                "list Nacos namespaces",
                vec![
                    (self.v3_path("/v3/admin/core/namespace/list", "/v3/console/core/namespace/list"), Vec::new()),
                    ("/v1/console/namespaces", Vec::new()),
                ],
            )
            .await
        {
            Ok(value) => {
                self.managed_namespace_fallback_used.store(false, Ordering::Relaxed);
                Ok(parse_namespaces(value))
            }
            Err(error) if classify_nacos_error(&error) == "authFailed" => {
                // Nacos 3's Admin namespace directory requires elevated
                // access. The Console directory is read-only and, on servers
                // that expose it through the same endpoint, returns the
                // namespace ID behind the name shown to an ordinary user.
                // Keep this as a narrowly scoped compatibility fallback: the
                // selected Admin or Console API plane still governs all
                // regular data operations.
                if matches!(self.cfg.version_mode, Some(NacosVersionMode::V3))
                    && self.explicitly_scoped_namespace_ids().is_none()
                {
                    if let Ok(value) = self.get_json("/v1/console/namespaces", Vec::new()).await {
                        self.managed_namespace_fallback_used.store(false, Ordering::Relaxed);
                        return Ok(parse_namespaces(value));
                    }
                }
                if let Some(managed_namespaces) = self.explicitly_scoped_namespace_ids() {
                    self.managed_namespace_fallback_used.store(true, Ordering::Relaxed);
                    return Ok(managed_namespaces
                        .into_iter()
                        .map(|namespace| NacosNamespaceInfo {
                            namespace: namespace.clone(),
                            namespace_show_name: namespace,
                            namespace_desc: None,
                            config_count: None,
                            quota: None,
                            namespace_type: None,
                        })
                        .collect());
                }
                Err(classified_error(
                    "managedNamespacesRequired",
                    &format!(
                        "{error}. This Nacos account cannot list namespaces. Enable the ordinary-user option and enter at least one namespace ID that the account is allowed to manage"
                    ),
                ))
            }
            Err(error) => Err(error),
        }
    }

    async fn create_namespace(&self, req: NacosNamespaceCreate) -> Result<(), String> {
        let namespace_id = req
            .namespace_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let namespace_name = req.namespace_name.trim().to_string();
        if namespace_name.is_empty() {
            return Err(classified_error("invalidNamespace", "Nacos namespace name is required"));
        }
        let namespace_desc = req
            .namespace_desc
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| namespace_name.clone());

        let mut v3_form = vec![
            ("namespaceName".to_string(), namespace_name.clone()),
            ("namespaceDesc".to_string(), namespace_desc.clone()),
        ];
        let mut v1_form =
            vec![("namespaceName".to_string(), namespace_name), ("namespaceDesc".to_string(), namespace_desc)];
        // Nacos consoles generate an ID client-side when the field is empty,
        // but the V3 Admin and Console forms expose different parameter names.
        let v3_namespace_id_key = if self.is_v3_console() { "customNamespaceId" } else { "namespaceId" };
        v3_form.push((v3_namespace_id_key.to_string(), namespace_id.clone()));
        v1_form.push(("customNamespaceId".to_string(), namespace_id.clone()));
        v1_form.push(("namespaceId".to_string(), namespace_id));

        self.submit_form_candidates(
            "create Nacos namespace",
            reqwest::Method::POST,
            vec![
                (self.v3_path("/v3/admin/core/namespace", "/v3/console/core/namespace"), v3_form),
                ("/v1/console/namespaces", v1_form.clone()),
                ("/v1/console/namespaces/create", v1_form),
            ],
        )
        .await
    }

    async fn update_namespace(&self, req: NacosNamespaceUpdate) -> Result<(), String> {
        let namespace_id = req.namespace_id.trim().to_string();
        if namespace_id.is_empty() {
            return Err(classified_error("invalidNamespace", "Nacos namespace ID is required"));
        }
        let namespace_name = req.namespace_name.trim().to_string();
        if namespace_name.is_empty() {
            return Err(classified_error("invalidNamespace", "Nacos namespace name is required"));
        }
        let namespace_desc = req
            .namespace_desc
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| namespace_name.clone());

        let v3_form = vec![
            ("namespaceId".to_string(), namespace_id.clone()),
            ("namespaceName".to_string(), namespace_name.clone()),
            ("namespaceDesc".to_string(), namespace_desc.clone()),
        ];
        let v1_form = vec![
            ("namespace".to_string(), namespace_id.clone()),
            ("namespaceId".to_string(), namespace_id.clone()),
            ("customNamespaceId".to_string(), namespace_id),
            ("namespaceShowName".to_string(), namespace_name.clone()),
            ("namespaceName".to_string(), namespace_name),
            ("namespaceDesc".to_string(), namespace_desc),
        ];

        self.submit_form_candidates(
            "update Nacos namespace",
            reqwest::Method::PUT,
            vec![
                (self.v3_path("/v3/admin/core/namespace", "/v3/console/core/namespace"), v3_form),
                ("/v1/console/namespaces", v1_form.clone()),
                ("/v1/console/namespaces/update", v1_form),
            ],
        )
        .await
    }

    async fn delete_namespace(&self, namespace_id: String) -> Result<(), String> {
        let namespace_id = namespace_id.trim().to_string();
        if namespace_id.is_empty() {
            return Err(classified_error("invalidNamespace", "Nacos namespace ID is required"));
        }
        let query = vec![("namespaceId".to_string(), namespace_id)];
        self.submit_query_candidates(
            "delete Nacos namespace",
            reqwest::Method::DELETE,
            vec![
                (self.v3_path("/v3/admin/core/namespace", "/v3/console/core/namespace"), query.clone()),
                ("/v1/console/namespaces", query.clone()),
                ("/v1/console/namespaces/delete", query),
            ],
        )
        .await
    }

    async fn list_configs(&self, query: NacosConfigQuery) -> Result<NacosConfigList, String> {
        let page_no = query.page_no.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(self.cfg.page_size).clamp(1, 500);
        let namespace = self.namespace(query.namespace.as_deref());
        let data_id_filter = query
            .data_id
            .clone()
            .or(query.search.clone())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let search = data_id_filter.clone().unwrap_or_default();
        let group_filter = query.group.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let group_contains = query.group_contains;
        let group = group_filter.clone().unwrap_or_default();
        let app_name_filter = query.app_name.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let app_name = app_name_filter.clone().unwrap_or_default();

        // Nacos v2, v3, and r-nacos do not agree on whether a group filter is
        // exact or fuzzy. Scan without that server-side constraint so the UI
        // always provides the same case-insensitive contains semantics.
        if group_contains && group_filter.is_some() {
            return self
                .list_configs_by_client_filters(
                    namespace,
                    data_id_filter,
                    group_filter,
                    app_name_filter,
                    page_no,
                    page_size,
                )
                .await;
        }

        let value = self.get_config_list_value(&namespace, &search, &group, &app_name, page_no, page_size).await?;
        let parsed =
            self.enrich_missing_config_formats(parse_config_list(value, namespace.clone(), page_no, page_size)).await;
        if data_id_filter.is_some() && parsed.items.is_empty() {
            let fallback = self
                .list_configs_by_client_filters(
                    namespace,
                    data_id_filter,
                    group_filter,
                    app_name_filter,
                    page_no,
                    page_size,
                )
                .await?;
            if !fallback.items.is_empty() {
                return Ok(fallback);
            }
        }
        Ok(parsed)
    }

    async fn search_config_content_page(
        &self,
        namespace: &str,
        query: &str,
        page_no: u32,
        page_size: u32,
    ) -> Result<Option<NacosConfigList>, String> {
        if self.is_explicit_rnacos() || matches!(self.cfg.version_mode, Some(NacosVersionMode::V2)) {
            return Ok(None);
        }
        let page_no = page_no.max(1);
        let page_size = page_size.clamp(1, 500);
        // The native endpoint interprets `configDetail` using Nacos wildcard
        // syntax. Callers only reach this fast path for wildcard-safe literal
        // queries, so wrapping the term gives us contains semantics; every
        // candidate is still fetched and verified with Rust `str::contains`.
        let config_detail = format!("*{query}*");
        let attempts = [(
            self.v3_path("/v3/admin/cs/config/list", "/v3/console/cs/config/searchDetail"),
            vec![
                ("configDetail".to_string(), config_detail),
                ("search".to_string(), "blur".to_string()),
                ("namespaceId".to_string(), namespace.to_string()),
                ("pageNo".to_string(), page_no.to_string()),
                ("pageSize".to_string(), page_size.to_string()),
            ],
        )];
        let mut unsupported = false;
        for (path, params) in attempts {
            if !self.api_path_allowed(path) {
                unsupported = true;
                continue;
            }
            let response = match self.request(reqwest::Method::GET, path, params, None, None).await {
                Ok(response) => response,
                Err(error) if content_search_endpoint_is_unsupported(&error) => {
                    unsupported = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let status = response.status();
            if matches!(
                status,
                reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED | reqwest::StatusCode::GONE
            ) {
                unsupported = true;
                continue;
            }
            let response = match error_for_status(response, path).await {
                Ok(response) => response,
                Err(error) if content_search_endpoint_is_unsupported(&error) => {
                    unsupported = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let value = response_json_or_text(response).await?;
            return Ok(Some(parse_config_list(value, namespace.to_string(), page_no, page_size)));
        }
        if unsupported {
            Ok(None)
        } else {
            Err(classified_error(
                "unsupportedContentSearch",
                "No compatible Nacos content-search endpoint is available",
            ))
        }
    }

    async fn get_config(&self, key: NacosConfigKey) -> Result<NacosConfigItem, String> {
        let namespace = self.namespace(key.namespace.as_deref());

        // r-nacos: console owns detail (content + type). OpenAPI is body-only fallback.
        if self.is_rnacos_compatible() {
            if !self.cfg.rnacos_console_addr.is_empty() {
                match self.get_rnacos_console_config(&key.data_id, &key.group, &namespace).await {
                    Ok(config) => return Ok(config),
                    Err(error) if error.contains("[rnacosConsoleCaptchaRequired]") => return Err(error),
                    Err(_) => {}
                }
            }
            return self.get_openapi_raw_config(&key.data_id, &key.group, &namespace).await;
        }

        // Official Nacos Open API.
        let v3_params = vec![
            ("dataId".to_string(), key.data_id.clone()),
            ("groupName".to_string(), key.group.clone()),
            ("namespaceId".to_string(), namespace.clone()),
        ];
        let v1_params = vec![
            ("dataId".to_string(), key.data_id.clone()),
            ("group".to_string(), key.group.clone()),
            ("tenant".to_string(), namespace.clone()),
        ];
        let mut v1_detail_params = v1_params.clone();
        v1_detail_params.push(("show".to_string(), "all".to_string()));

        let mut errors = Vec::new();
        for (path, query) in [
            (self.v3_path("/v3/admin/cs/config", "/v3/console/cs/config"), v3_params),
            ("/v1/cs/configs", v1_detail_params),
            ("/v1/cs/configs", v1_params),
        ] {
            if !self.api_path_allowed(path) {
                continue;
            }
            let show_all =
                path == "/v1/cs/configs" && query.iter().any(|(name, value)| name == "show" && value == "all");
            match self.request(reqwest::Method::GET, path, query, None, None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(resp) if path == "/v1/cs/configs" => {
                        let text =
                            resp.text().await.map_err(|e| format!("Failed to read Nacos config response: {e}"))?;
                        // show=all → detail JSON; default GET → opaque content text.
                        if show_all {
                            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                return Ok(parse_config_detail(value, key.data_id, key.group, namespace));
                            }
                        }
                        return Ok(NacosConfigItem {
                            data_id: key.data_id,
                            group: key.group,
                            namespace,
                            app_name: None,
                            desc: None,
                            tags: None,
                            config_type: None,
                            md5: None,
                            encrypted_data_key: None,
                            content: Some(text),
                        });
                    }
                    Ok(resp) => {
                        let value = response_json_or_text(resp).await?;
                        return Ok(parse_config_detail(value, key.data_id, key.group, namespace));
                    }
                    Err(err) => errors.push(err),
                },
                Err(err) => errors.push(err),
            }
        }
        Err(format!("Failed to get Nacos config: {}", errors.join("; ")))
    }

    async fn publish_config(&self, req: NacosConfigUpsert) -> Result<(), String> {
        let namespace = self.namespace(req.namespace.as_deref());
        let (v3_form, v1_form) = build_publish_forms(req, namespace);

        let mut errors = Vec::new();
        for (path, form) in [(self.v3_path("/v3/admin/cs/config", "/v3/console/cs/config"), v3_form)] {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.request(reqwest::Method::POST, path, Vec::new(), Some(form), None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(_) => return Ok(()),
                    Err(err) => errors.push(err),
                },
                Err(err) => errors.push(err),
            }
        }
        if !self.api_path_allowed("/v1/cs/configs") {
            return Err(format!("Failed to publish Nacos config: {}", errors.join("; ")));
        }
        match self.request(reqwest::Method::POST, "/v1/cs/configs", Vec::new(), Some(v1_form), None).await {
            Ok(resp) => match error_for_status(resp, "/v1/cs/configs").await {
                Ok(_) => Ok(()),
                Err(err) => {
                    errors.push(err);
                    Err(format!("Failed to publish Nacos config: {}", errors.join("; ")))
                }
            },
            Err(err) => {
                errors.push(err);
                Err(format!("Failed to publish Nacos config: {}", errors.join("; ")))
            }
        }
    }

    async fn delete_config(&self, key: NacosConfigKey) -> Result<(), String> {
        let namespace = self.namespace(key.namespace.as_deref());
        let v3_query = vec![
            ("dataId".to_string(), key.data_id.clone()),
            ("groupName".to_string(), key.group.clone()),
            ("namespaceId".to_string(), namespace.clone()),
        ];
        let v1_query = vec![
            ("dataId".to_string(), key.data_id),
            ("group".to_string(), key.group),
            ("tenant".to_string(), namespace),
        ];
        self.submit_query_candidates(
            "delete Nacos config",
            reqwest::Method::DELETE,
            vec![
                (self.v3_path("/v3/admin/cs/config", "/v3/console/cs/config"), v3_query),
                ("/v1/cs/configs", v1_query),
            ],
        )
        .await
    }

    async fn list_config_history(&self, query: NacosConfigHistoryQuery) -> Result<NacosConfigHistoryList, String> {
        let page_no = query.page_no.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(self.cfg.page_size).clamp(1, 500);
        let namespace = self.namespace(query.namespace.as_deref());
        let v3_params = vec![
            ("search".to_string(), "accurate".to_string()),
            ("dataId".to_string(), query.data_id.clone()),
            ("groupName".to_string(), query.group.clone()),
            ("namespaceId".to_string(), namespace.clone()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        let v1_params = vec![
            ("search".to_string(), "accurate".to_string()),
            ("dataId".to_string(), query.data_id.clone()),
            ("group".to_string(), query.group.clone()),
            ("tenant".to_string(), namespace.clone()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        let value = match self
            .get_json_from_candidates(
                "list Nacos config history",
                vec![
                    (self.v3_path("/v3/admin/cs/history/list", "/v3/console/cs/history/list"), v3_params),
                    ("/v1/cs/history/list", v1_params.clone()),
                    ("/v1/cs/history", v1_params.clone()),
                    ("/v1/cs/history/configs", v1_params),
                ],
            )
            .await
        {
            Ok(value) => value,
            Err(nacos_error) => match self
                .list_rnacos_config_history(&namespace, &query.data_id, &query.group, page_no, page_size)
                .await
            {
                Ok(value) => value,
                Err(rnacos_error) if rnacos_error.contains("[rnacosConsoleCaptchaRequired]") => {
                    return Err(rnacos_error)
                }
                Err(rnacos_error) => {
                    return Err(classified_error(
                        "unsupportedConfigHistory",
                        &format!("{nacos_error}; r-nacos console history fallback failed: {rnacos_error}"),
                    ));
                }
            },
        };
        Ok(parse_config_history_list(value, namespace, page_no, page_size, &query.data_id, &query.group))
    }

    async fn get_config_history(&self, key: NacosConfigHistoryKey) -> Result<NacosConfigItem, String> {
        let namespace = self.namespace(key.namespace.as_deref());
        let nid = key.nid.or_else(|| key.history_id.parse::<i64>().ok());
        let mut v3_params = vec![
            ("dataId".to_string(), key.data_id.clone()),
            ("groupName".to_string(), key.group.clone()),
            ("namespaceId".to_string(), namespace.clone()),
            ("id".to_string(), key.history_id.clone()),
        ];
        if let Some(nid) = nid {
            v3_params.push(("nid".to_string(), nid.to_string()));
        }
        let mut v1_params = vec![
            ("dataId".to_string(), key.data_id.clone()),
            ("group".to_string(), key.group.clone()),
            ("tenant".to_string(), namespace.clone()),
        ];
        if let Some(nid) = nid {
            v1_params.push(("nid".to_string(), nid.to_string()));
        } else {
            v1_params.push(("id".to_string(), key.history_id.clone()));
        }
        let value = match self
            .get_json_from_candidates(
                "get Nacos config history",
                vec![
                    (self.v3_path("/v3/admin/cs/history", "/v3/console/cs/history"), v3_params),
                    ("/v1/cs/history", v1_params.clone()),
                    ("/v1/cs/history/config", v1_params),
                ],
            )
            .await
        {
            Ok(value) => value,
            Err(nacos_error) => {
                // r-nacos returns the historical content in its list response and
                // has no separate history-detail endpoint. It keeps at most 100
                // revisions, so a single maximum-size page can locate the item.
                let history = self
                    .list_rnacos_config_history(&namespace, &key.data_id, &key.group, 1, 500)
                    .await
                    .map_err(|rnacos_error| {
                        if rnacos_error.contains("[rnacosConsoleCaptchaRequired]") {
                            rnacos_error
                        } else {
                            classified_error(
                                "unsupportedConfigHistory",
                                &format!("{nacos_error}; r-nacos console history fallback failed: {rnacos_error}"),
                            )
                        }
                    })?;
                let item = rnacos_history_item(&history, &key.history_id, nid).ok_or_else(|| {
                    classified_error(
                        "unsupportedConfigHistory",
                        &format!("r-nacos console history version {} was not found", key.history_id),
                    )
                })?;
                return Ok(parse_config_history_detail(item, key.data_id, key.group, namespace));
            }
        };
        Ok(parse_config_history_detail(value, key.data_id, key.group, namespace))
    }

    async fn rollback_config(&self, req: NacosConfigRollbackRequest) -> Result<(), String> {
        let namespace = self.namespace(req.namespace.as_deref());
        let nid = req.nid.or_else(|| req.history_id.parse::<i64>().ok());
        let data_id = req.data_id.clone();
        let group = req.group.clone();
        let history_id = req.history_id.clone();
        let mut v1_query = vec![
            ("dataId".to_string(), req.data_id),
            ("group".to_string(), req.group),
            ("tenant".to_string(), namespace.clone()),
        ];
        if let Some(nid) = nid {
            v1_query.push(("nid".to_string(), nid.to_string()));
        } else {
            v1_query.push(("id".to_string(), req.history_id));
        }
        // The Nacos 3 Admin API exposes history reads but no rollback route.
        // Re-publishing the selected revision is the documented, deterministic
        // rollback implementation. Older compatible APIs keep their direct
        // endpoint probes below.
        let endpoint_result = if matches!(self.cfg.version_mode, Some(NacosVersionMode::V3)) {
            Err("Nacos v3 Admin API uses history read and publish for rollback".to_string())
        } else {
            self.submit_query_candidates(
                "rollback Nacos config",
                reqwest::Method::POST,
                vec![("/v1/cs/history/rollback", v1_query.clone()), ("/v1/cs/history/config/rollback", v1_query)],
            )
            .await
        };
        if endpoint_result.is_ok() {
            return Ok(());
        }
        let endpoint_err = endpoint_result.unwrap_err();
        let history = self
            .get_config_history(NacosConfigHistoryKey {
                namespace: Some(namespace.clone()),
                data_id: data_id.clone(),
                group: group.clone(),
                history_id,
                nid,
            })
            .await
            .map_err(|history_err| {
                classified_error(
                    "unsupportedConfigHistory",
                    &format!("{endpoint_err}; failed to load history content for publish fallback: {history_err}"),
                )
            })?;
        let content = history.content.clone().ok_or_else(|| {
            classified_error(
                "unsupportedConfigHistory",
                &format!("{endpoint_err}; history version did not include content for rollback"),
            )
        })?;
        self.publish_config(NacosConfigUpsert {
            namespace: Some(namespace),
            data_id,
            group,
            content,
            config_type: history.config_type,
            app_name: history.app_name,
            desc: history.desc,
            tags: history.tags,
        })
        .await
        .map_err(|publish_err| {
            classified_error(
                "unsupportedConfigHistory",
                &format!("{endpoint_err}; failed to publish history content for rollback: {publish_err}"),
            )
        })
    }

    async fn list_services(&self, query: NacosServiceQuery) -> Result<NacosServiceList, String> {
        let page_no = query.page_no.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(self.cfg.page_size).clamp(1, 500);
        let namespace = self.namespace(query.namespace.as_deref());
        let mut v3_params = vec![
            ("namespaceId".to_string(), namespace.clone()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        push_optional(&mut v3_params, "groupNameParam", query.group_name.clone());
        push_optional(&mut v3_params, "serviceNameParam", query.service_name.clone());
        let requested_group = query.group_name.clone();
        let mut v2_params = vec![
            ("namespaceId".to_string(), namespace.clone()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        // Nacos v2 uses the service API's field names rather than the v3
        // console list aliases (`groupNameParam` and `serviceNameParam`).
        push_optional(&mut v2_params, "groupName", query.group_name.clone());
        push_optional(&mut v2_params, "serviceName", query.service_name.clone());
        let mut v1_catalog_params = vec![
            ("namespaceId".to_string(), namespace.clone()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        push_optional(&mut v1_catalog_params, "groupNameParam", query.group_name.clone());
        push_optional(&mut v1_catalog_params, "serviceNameParam", query.service_name.clone());
        let mut v1_legacy_params = vec![
            ("namespaceId".to_string(), namespace),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        push_optional(&mut v1_legacy_params, "groupName", query.group_name);
        push_optional(&mut v1_legacy_params, "serviceName", query.service_name);
        if self.is_rnacos_compatible() {
            // r-nacos returns only the default group from the ordinary Naming
            // list endpoint when no group is supplied. Its compatible Catalog
            // service endpoint is the management view that can enumerate
            // services across groups, just as it is for Nacos v2.
            let value = self.get_json("/v1/ns/catalog/services", v1_catalog_params).await?;
            let mut result = parse_service_list(value, page_no, page_size);
            if let Some(group_name) = requested_group.filter(|group| !group.trim().is_empty()) {
                for service in &mut result.items {
                    if service.group_name.is_none() {
                        service.group_name = Some(group_name.clone());
                    }
                }
            }
            return Ok(result);
        }
        let value = self
            .get_service_json_from_candidates(
                "list Nacos services",
                vec![
                    (self.v3_path("/v3/admin/ns/service/list", "/v3/console/ns/service/list"), v3_params.clone()),
                    // The catalog endpoint is what the Nacos v2 console uses
                    // to enumerate services across every group. `/v2/ns/service/list`
                    // returns a valid-but-empty response without `groupName`, which
                    // must not prevent this cross-group query from being attempted.
                    ("/v1/ns/catalog/services", v1_catalog_params.clone()),
                    ("/v2/ns/service/list", v2_params.clone()),
                    ("/v1/ns/service/list", v1_legacy_params),
                ],
            )
            .await?;
        let mut result = parse_service_list(value, page_no, page_size);
        // Nacos does not include empty services in the v2 catalog response.
        // When a group is explicitly selected, query the direct v2 API as a
        // supplement so manually-created empty services remain manageable.
        if result.items.is_empty()
            && requested_group.as_deref().is_some_and(|group| !group.trim().is_empty())
            && self.api_path_allowed("/v2/ns/service/list")
        {
            if let Ok(value) = self.get_json("/v2/ns/service/list", v2_params).await {
                result = parse_service_list(value, page_no, page_size);
            }
        }
        // The v2 list API returns plain service names and omits the matched
        // group. Preserve the requested group so subsequent detail, update,
        // and instance calls address the same service identity.
        if let Some(group_name) = requested_group.filter(|group| !group.trim().is_empty()) {
            for service in &mut result.items {
                if service.group_name.is_none() {
                    service.group_name = Some(group_name.clone());
                }
            }
        }
        Ok(result)
    }

    async fn get_service(&self, query: NacosServiceQuery) -> Result<NacosServiceDetail, String> {
        let namespace = self.namespace(query.namespace.as_deref());
        let service_name = query.service_name.ok_or_else(|| "Nacos service name is required".to_string())?;
        if self.is_rnacos_compatible() {
            // r-nacos reads a grouped service detail through the compatible
            // v1 endpoint, but derives the group from `serviceName` rather
            // than honoring a separate `groupName` parameter.
            let params = vec![
                ("namespaceId".to_string(), namespace),
                ("serviceName".to_string(), qualified_nacos_service_name(&service_name, query.group_name.as_deref())),
            ];
            return self.get_json("/v1/ns/service", params).await.map(parse_service_detail);
        }
        let mut params = vec![("namespaceId".to_string(), namespace), ("serviceName".to_string(), service_name)];
        push_optional(&mut params, "groupName", query.group_name);
        let value = self
            .get_service_json_from_candidates(
                "get Nacos service",
                vec![
                    (self.v3_path("/v3/admin/ns/service", "/v3/console/ns/service"), params.clone()),
                    ("/v1/ns/service", params),
                ],
            )
            .await?;
        Ok(parse_service_detail(value))
    }

    async fn create_service(&self, req: NacosServiceUpsert) -> Result<(), String> {
        self.submit_service_upsert("create Nacos service", req, reqwest::Method::POST).await
    }

    async fn update_service(&self, req: NacosServiceUpsert) -> Result<(), String> {
        self.submit_service_upsert("update Nacos service", req, reqwest::Method::PUT).await
    }

    async fn delete_service(&self, query: NacosServiceQuery) -> Result<(), String> {
        let namespace = self.namespace(query.namespace.as_deref());
        let service_name = query.service_name.ok_or_else(|| "Nacos service name is required".to_string())?;
        let mut params = vec![("namespaceId".to_string(), namespace), ("serviceName".to_string(), service_name)];
        push_optional(&mut params, "groupName", query.group_name);
        self.submit_service_query_candidates(
            "delete Nacos service",
            reqwest::Method::DELETE,
            vec![
                (self.v3_path("/v3/admin/ns/service", "/v3/console/ns/service"), params.clone()),
                ("/v1/ns/service", params),
            ],
        )
        .await
    }

    async fn list_instances(&self, query: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String> {
        let namespace = self.namespace(query.namespace.as_deref());
        let requested_clusters = split_nacos_cluster_names(query.clusters.as_deref());
        let mut params = vec![
            ("serviceName".to_string(), query.service_name.clone()),
            ("namespaceId".to_string(), namespace.clone()),
        ];
        push_optional(&mut params, "groupName", query.group_name.clone());
        push_optional(&mut params, "clusters", query.clusters.clone());

        if self.is_rnacos_compatible() {
            // The compatible discovery API only lists enabled instances. When
            // the optional r-nacos console has been configured, prefer its
            // authenticated management endpoint so disabled persistent
            // instances remain operable in DBX as well.
            if !self.cfg.rnacos_console_addr.is_empty() {
                match self.list_rnacos_console_instances(&query, &namespace, &requested_clusters).await {
                    Ok(instances) => return Ok(instances),
                    Err(error) if error.contains("[rnacosConsoleCaptchaRequired]") => return Err(error),
                    // The console is optional for r-nacos. A connection,
                    // permission, or version failure must not hide the
                    // regular compatible discovery result.
                    Err(_) => {}
                }
            }
            let value = self.get_json("/v1/ns/instance/list", params).await?;
            return Ok(filter_instances_by_clusters(parse_instances(value), &requested_clusters));
        }

        let mut errors = Vec::new();
        let v3_instance_list_path = self.v3_path("/v3/admin/ns/instance/list", "/v3/console/ns/instance/list");
        if self.api_path_allowed(v3_instance_list_path) {
            match self.list_v3_admin_instances(&query, &namespace).await {
                Ok(instances) => return Ok(filter_instances_by_clusters(instances, &requested_clusters)),
                Err(err) => {
                    let try_next = self.should_try_next_candidate(&err);
                    errors.push(err);
                    if !try_next {
                        return Err(format!("Failed to list Nacos instances: {}", errors.join("; ")));
                    }
                }
            }
        }

        // Nacos v2's ordinary Naming list endpoint omits disabled instances.
        // The Catalog controller is the management view and deliberately
        // includes them, so use it before v1/v2 Naming fallbacks.
        if self.api_path_allowed("/v1/ns/catalog/instances") {
            match self.list_v1_catalog_instances(&query, &namespace).await {
                Ok(instances) => return Ok(filter_instances_by_clusters(instances, &requested_clusters)),
                Err(err) => {
                    let try_next = self.should_try_next_candidate(&err);
                    errors.push(err);
                    if !try_next {
                        return Err(format!("Failed to list Nacos instances: {}", errors.join("; ")));
                    }
                }
            }
        }

        for path in ["/v1/ns/instance/list", "/v2/ns/instance/list"] {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.get_json(path, params.clone()).await {
                Ok(value) => return Ok(filter_instances_by_clusters(parse_instances(value), &requested_clusters)),
                Err(err) => {
                    let try_next = self.should_try_next_candidate(&err);
                    errors.push(err);
                    if !try_next {
                        return Err(format!("Failed to list Nacos instances: {}", errors.join("; ")));
                    }
                }
            }
        }
        Err(format!("Failed to list Nacos instances: {}", errors.join("; ")))
    }

    async fn list_instances_for_service_delete(
        &self,
        query: NacosInstanceQuery,
    ) -> Result<Vec<NacosInstanceInfo>, String> {
        if self.is_rnacos_compatible() {
            if self.cfg.rnacos_console_addr.trim().is_empty() {
                return Err(
                    "NACOS_ERROR[endpointUnavailable]: r-nacos service deletion requires a configured r-nacos console address so DBX can verify disabled instances"
                        .to_string(),
                );
            }
            let namespace = self.namespace(query.namespace.as_deref());
            let requested_clusters = split_nacos_cluster_names(query.clusters.as_deref());
            return self.list_rnacos_console_instances(&query, &namespace, &requested_clusters).await;
        }
        self.list_instances(query).await
    }

    async fn update_instance(&self, req: NacosInstanceUpdateRequest) -> Result<(), String> {
        if req.target.service_name.trim().is_empty()
            || req.target.ip.parse::<std::net::IpAddr>().is_err()
            || req.target.port == 0
        {
            return Err("Nacos instance service name, valid IP, and port are required".to_string());
        }
        if req.patch.enabled.is_none()
            && req.patch.healthy.is_none()
            && req.patch.weight.is_none()
            && req.patch.metadata.is_none()
        {
            return Err("Nacos instance update patch must contain at least one field".to_string());
        }
        if req.patch.weight.is_some_and(|value| !value.is_finite() || value < 0.0) {
            return Err("Nacos instance weight must be a finite number greater than or equal to 0".to_string());
        }
        if req.patch.metadata.as_ref().is_some_and(|value| !value.is_object()) {
            return Err("Nacos instance metadata must be a JSON object".to_string());
        }
        if self.is_official_v3() && req.patch.healthy.is_some() {
            return Err(classified_error(
                "unsupportedOperation",
                "Official Nacos 3 management APIs cannot override an instance health state",
            ));
        }
        let v3_instance_update_path = self.v3_path("/v3/admin/ns/instance/partial", "/v3/console/ns/instance");
        if self.api_path_allowed(v3_instance_update_path) {
            match self.update_v3_admin_instance(req.clone()).await {
                Ok(()) => return Ok(()),
                Err(err) if self.should_try_next_candidate(&err) => {}
                Err(err) => return Err(format!("Failed to update Nacos instance: {err}")),
            }
        }
        if !self.api_path_allowed("/v1/ns/instance") {
            return Err("Failed to update Nacos instance: no compatible management endpoint is available".to_string());
        }
        let namespace = self.namespace(req.target.namespace.as_deref());
        let form = instance_update_form(namespace, req);
        let response = self.request(reqwest::Method::PUT, "/v1/ns/instance", Vec::new(), Some(form), None).await?;
        error_for_status(response, "/v1/ns/instance").await?;
        Ok(())
    }

    async fn register_instance(&self, req: NacosInstanceRegistration) -> Result<(), String> {
        if req.service_name.trim().is_empty() || req.ip.parse::<std::net::IpAddr>().is_err() || req.port == 0 {
            return Err("Nacos instance service name, valid IP, and port are required".to_string());
        }
        if req.weight.is_some_and(|value| !value.is_finite() || value < 0.0) {
            return Err("Nacos instance weight must be a finite number greater than or equal to 0".to_string());
        }
        if req.metadata.as_ref().is_some_and(|value| !value.is_object()) {
            return Err("Nacos instance metadata must be a JSON object".to_string());
        }
        let form = instance_registration_form(self.namespace(req.namespace.as_deref()), req);
        self.submit_service_form_candidates(
            "register Nacos instance",
            reqwest::Method::POST,
            vec![("/v3/admin/ns/instance", form.clone()), ("/v1/ns/instance", form)],
        )
        .await
    }

    async fn deregister_instance(&self, req: NacosInstanceRef) -> Result<(), String> {
        if req.service_name.trim().is_empty() || req.ip.parse::<std::net::IpAddr>().is_err() || req.port == 0 {
            return Err("Nacos instance service name, valid IP, and port are required".to_string());
        }
        let namespace = self.namespace(req.namespace.as_deref());
        let mut params = vec![
            ("namespaceId".to_string(), namespace),
            ("serviceName".to_string(), req.service_name),
            ("ip".to_string(), req.ip),
            ("port".to_string(), req.port.to_string()),
        ];
        push_optional(&mut params, "groupName", req.group_name);
        push_optional(&mut params, "clusterName", req.cluster_name);
        if let Some(ephemeral) = req.ephemeral {
            params.push(("ephemeral".to_string(), ephemeral.to_string()));
        }
        self.submit_service_query_candidates(
            "deregister Nacos instance",
            reqwest::Method::DELETE,
            vec![("/v3/admin/ns/instance", params.clone()), ("/v1/ns/instance", params)],
        )
        .await
    }

    async fn get_dashboard(&self, query: NacosDashboardQuery) -> Result<NacosDashboardSnapshot, String> {
        let namespace = self.namespace(query.namespace.as_deref());
        let metrics_future = async {
            if self.is_v3_console() {
                None
            } else {
                Some(
                    self.get_json_from_candidates(
                        "load Nacos dashboard metrics",
                        vec![
                            ("/v3/admin/ns/ops/metrics", vec![("onlyStatus".to_string(), "false".to_string())]),
                            ("/v2/ns/operator/metrics", vec![("onlyStatus".to_string(), "false".to_string())]),
                            ("/v1/ns/operator/metrics", Vec::new()),
                        ],
                    )
                    .await,
                )
            }
        };
        let nodes_future = self.get_dashboard_nodes();
        let namespaces_future = self.list_namespaces();
        let configs_future = self.list_configs(NacosConfigQuery {
            namespace: Some(namespace.clone()),
            group: None,
            group_contains: false,
            data_id: None,
            app_name: None,
            search: None,
            page_no: Some(1),
            page_size: Some(1),
        });
        let services_future = self.list_services(NacosServiceQuery {
            namespace: Some(namespace.clone()),
            group_name: None,
            service_name: None,
            page_no: Some(1),
            page_size: Some(1),
        });
        let prometheus_future = crate::nacos::prometheus::scrape(&self.http, &self.cfg);

        let (metrics_result, nodes_result, namespaces_result, configs_result, services_result, prometheus_result) = tokio::join!(
            metrics_future,
            nodes_future,
            namespaces_future,
            configs_future,
            services_future,
            prometheus_future
        );
        let mut warnings = Vec::new();

        let mut metrics = match metrics_result {
            Some(Ok(value)) => Some(parse_dashboard_metrics(value)),
            Some(Err(error)) => {
                warnings.push(self.dashboard_warning(error));
                None
            }
            None => None,
        };
        let nodes = match nodes_result {
            Ok(value) => value,
            Err(error) => {
                warnings.push(self.dashboard_warning(error));
                Vec::new()
            }
        };
        let namespace_count = match namespaces_result {
            Ok(items) => Some(items.len() as u64),
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        let config_count = match configs_result {
            Ok(result) => Some(result.total_count),
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        let service_count = match services_result {
            Ok(result) => Some(result.total_count),
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        let prometheus = match prometheus_result {
            Ok(value) => value,
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        merge_prometheus_dashboard(&mut metrics, prometheus.as_ref());

        Ok(NacosDashboardSnapshot {
            namespace,
            namespace_count,
            config_count,
            service_count,
            metrics,
            prometheus,
            nodes,
            warnings,
        })
    }

    async fn raw_request(&self, req: NacosRawRequest) -> Result<NacosRawResponse, String> {
        validate_raw_api_path(&req.path)?;
        if !self.api_path_allowed(&req.path) {
            return Err(classified_error(
                "unsupportedOperation",
                "The raw Nacos API path is outside the selected API mode",
            ));
        }
        let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
            .map_err(|e| format!("Invalid Nacos raw request method: {e}"))?;
        let mut query = req.query.unwrap_or_default().into_iter().collect::<Vec<_>>();
        query.sort_by(|a, b| a.0.cmp(&b.0));
        let resp = self.request(method, &req.path, query, None, req.body).await?;
        let status = resp.status().as_u16();
        let headers = response_headers(resp.headers());
        let bytes = resp.bytes().await.map_err(|e| format!("Failed to read Nacos raw response: {e}"))?;
        if bytes.len() > MAX_RAW_RESPONSE_BYTES {
            return Err(format!("Nacos raw response exceeds {} bytes", MAX_RAW_RESPONSE_BYTES));
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| Value::String(text.clone()));
        Ok(NacosRawResponse { status, body: serde_json::json!({ "headers": headers, "body": body }), text: Some(text) })
    }
}

pub fn validate_raw_api_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(classified_error("invalidRawPath", "Nacos raw API path is empty"));
    }
    if trimmed.contains("://") || trimmed.starts_with("//") {
        return Err(classified_error(
            "invalidRawPath",
            "Nacos raw API path must be a relative API path, not a full URL",
        ));
    }
    if !trimmed.starts_with('/') {
        return Err(classified_error("invalidRawPath", "Nacos raw API path must start with /v1, /v2, or /v3"));
    }
    if trimmed.contains('\\') || trimmed.split('/').any(|segment| segment == ".." || segment == ".") {
        return Err(classified_error("invalidRawPath", "Nacos raw API path must not contain path traversal segments"));
    }
    if !matches!(trimmed.split('/').nth(1), Some("v1" | "v2" | "v3")) {
        return Err(classified_error("invalidRawPath", "Nacos raw API path must start with /v1, /v2, or /v3"));
    }
    Ok(())
}

fn parse_namespaces(value: Value) -> Vec<NacosNamespaceInfo> {
    let data = value.get("data").unwrap_or(&value);
    let items: Vec<Value> = data
        .as_array()
        .cloned()
        .or_else(|| data.get("namespaces").and_then(Value::as_array).cloned())
        .or_else(|| data.get("pageItems").and_then(Value::as_array).cloned())
        .or_else(|| data.get("items").and_then(Value::as_array).cloned())
        .or_else(|| value.get("namespaces").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut namespaces: Vec<NacosNamespaceInfo> = items
        .into_iter()
        .map(|item| {
            let namespace =
                optional_string_field(&item, &["namespace", "namespaceId", "namespace_id", "tenant", "tenantId"])
                    .unwrap_or_default();
            let show_name = optional_string_field(&item, &["namespaceShowName", "namespaceName", "name", "showName"])
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| if namespace.is_empty() { "public".to_string() } else { namespace.clone() });
            NacosNamespaceInfo {
                namespace,
                namespace_show_name: show_name,
                namespace_desc: optional_string_field(
                    &item,
                    &["namespaceDesc", "namespace_desc", "description", "desc"],
                ),
                config_count: optional_u64_field(&item, &["configCount"]),
                quota: optional_u64_field(&item, &["quota"]),
                namespace_type: optional_u64_field(&item, &["type", "namespaceType"]),
            }
        })
        .collect();
    // Nacos 3 reports the default namespace with the concrete `public` ID,
    // while older endpoints commonly use an empty ID. Add a synthetic default
    // only when neither representation was returned.
    if !namespaces.iter().any(|item| item.namespace.is_empty() || item.namespace == "public") {
        namespaces.insert(
            0,
            NacosNamespaceInfo {
                namespace: String::new(),
                namespace_show_name: "public".to_string(),
                namespace_desc: None,
                config_count: None,
                quota: None,
                namespace_type: None,
            },
        );
    }
    namespaces
}

fn validated_nacos_username(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(classified_error("invalidUser", "Nacos username is required"));
    }
    Ok(value.to_string())
}

fn validated_nacos_role(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(classified_error("invalidRole", "Nacos role is required"));
    }
    Ok(value.to_string())
}

fn validated_nacos_permission_action(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if matches!(value.as_str(), "r" | "w" | "rw") {
        Ok(value)
    } else {
        Err(classified_error("invalidPermission", "Nacos permission action must be r, w, or rw"))
    }
}

fn parse_permission_scope(resource: &str) -> Option<NacosPermissionScope> {
    let resource = resource.trim();
    if resource.is_empty() {
        return Some(NacosPermissionScope { kind: NacosPermissionScopeKind::Unknown, namespace_id: None });
    }
    if resource == "*:*:*" {
        return Some(NacosPermissionScope { kind: NacosPermissionScopeKind::Global, namespace_id: None });
    }
    if let Some(namespace_id) = resource.strip_suffix(":*:*") {
        if !namespace_id.contains(':') && namespace_id != "*" {
            return Some(NacosPermissionScope {
                kind: NacosPermissionScopeKind::Namespace,
                namespace_id: Some(if namespace_id.is_empty() {
                    "public".to_string()
                } else {
                    namespace_id.to_string()
                }),
            });
        }
        return Some(NacosPermissionScope { kind: NacosPermissionScopeKind::Custom, namespace_id: None });
    }
    Some(NacosPermissionScope { kind: NacosPermissionScopeKind::Custom, namespace_id: None })
}

fn rnacos_user_payload(
    username: &str,
    password: Option<&str>,
    nickname: Option<&str>,
    enabled: Option<bool>,
    roles: Option<&[String]>,
    namespace_privilege: Option<&NacosNamespacePrivilege>,
    create: bool,
) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("username".to_string(), Value::String(username.to_string()));
    if let Some(password) = password.filter(|value| !value.is_empty()) {
        payload.insert("password".to_string(), Value::String(password.to_string()));
    }
    if let Some(nickname) = nickname.map(str::trim).filter(|value| !value.is_empty()) {
        payload.insert("nickname".to_string(), Value::String(nickname.to_string()));
    } else if create {
        payload.insert("nickname".to_string(), Value::String(username.to_string()));
    }
    if let Some(enabled) = enabled {
        payload.insert("enable".to_string(), Value::Bool(enabled));
    }
    if let Some(roles) = roles {
        payload.insert(
            "roles".to_string(),
            Value::String(
                roles.iter().map(|role| role.trim()).filter(|role| !role.is_empty()).collect::<Vec<_>>().join(","),
            ),
        );
    }
    if let Some(privilege) = namespace_privilege {
        // r-nacos' UpdateUserInfoParam accepts only PrivilegeGroupOptionParam
        // here. The response's `enabled` flag is derived server-side and is
        // intentionally not a writable request field.
        payload.insert(
            "namespacePrivilegeParam".to_string(),
            serde_json::json!({
                "whitelistIsAll": privilege.whitelist_is_all,
                "whitelist": privilege.whitelist,
                "blacklistIsAll": privilege.blacklist_is_all,
                "blacklist": privilege.blacklist,
            }),
        );
    }
    Value::Object(payload)
}

fn parse_user_list(value: Value, page_no: u32, page_size: u32) -> NacosUserList {
    let data = value.get("data").unwrap_or(&value);
    let total_count = optional_u64_field(data, &["totalCount", "count"])
        .or_else(|| optional_u64_field(&value, &["totalCount", "count"]))
        .unwrap_or_default();
    let items: Vec<NacosUserInfo> = data
        .get("pageItems")
        .or_else(|| data.get("list"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("pageItems"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let username = optional_string_field(&item, &["username", "userName"])?;
            let roles = item
                .get("roles")
                .and_then(Value::as_array)
                .map(|roles| roles.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
                .unwrap_or_default();
            let namespace_privilege = item.get("namespacePrivilege").map(|privilege| NacosNamespacePrivilege {
                enabled: optional_bool_field(privilege, &["enabled"]).unwrap_or(true),
                whitelist_is_all: optional_bool_field(privilege, &["whitelistIsAll"]).unwrap_or(true),
                whitelist: privilege
                    .get("whitelist")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default(),
                blacklist_is_all: optional_bool_field(privilege, &["blacklistIsAll"]).unwrap_or(false),
                blacklist: privilege
                    .get("blacklist")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default(),
            });
            Some(NacosUserInfo {
                username,
                nickname: optional_string_field(&item, &["nickname"]),
                enabled: optional_bool_field(&item, &["enable", "enabled"]),
                roles,
                namespace_privilege,
                source: optional_string_field(&item, &["source"]),
            })
        })
        .collect();
    let total_count = if total_count == 0 { items.len() as u64 } else { total_count };
    NacosUserList { page_no, page_size, total_count, items }
}

fn parse_role_list(value: Value, page_no: u32, page_size: u32) -> NacosRoleList {
    let data = value.get("data").unwrap_or(&value);
    let total_count = optional_u64_field(data, &["totalCount", "count"])
        .or_else(|| optional_u64_field(&value, &["totalCount", "count"]))
        .unwrap_or_default();
    let items: Vec<NacosRoleBinding> = data
        .get("pageItems")
        .or_else(|| data.get("list"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("pageItems"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            Some(NacosRoleBinding {
                username: optional_string_field(&item, &["username", "userName"])?,
                role: optional_string_field(&item, &["role"])?,
            })
        })
        .collect();
    let total_count = if total_count == 0 { items.len() as u64 } else { total_count };
    NacosRoleList { page_no, page_size, total_count, items }
}

fn parse_permission_list(value: Value, page_no: u32, page_size: u32) -> NacosPermissionList {
    let data = value.get("data").unwrap_or(&value);
    let total_count = optional_u64_field(data, &["totalCount", "count"])
        .or_else(|| optional_u64_field(&value, &["totalCount", "count"]))
        .unwrap_or_default();
    let items: Vec<NacosPermissionInfo> = data
        .get("pageItems")
        .or_else(|| data.get("list"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("pageItems"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let role = optional_string_field(&item, &["role"])?;
            let resource_raw = optional_string_field(&item, &["resource"])?;
            let action_raw = optional_string_field(&item, &["action"])?;
            Some(NacosPermissionInfo {
                role,
                parsed_scope: parse_permission_scope(&resource_raw),
                resource_raw,
                action_raw,
            })
        })
        .collect();
    let total_count = if total_count == 0 { items.len() as u64 } else { total_count };
    NacosPermissionList { page_no, page_size, total_count, items }
}

fn parse_dashboard_metrics(value: Value) -> NacosDashboardMetrics {
    let data = value.get("data").unwrap_or(&value);
    NacosDashboardMetrics {
        status: optional_string_field(data, &["status"])
            .or_else(|| data.as_str().map(str::to_string))
            .filter(|value| !value.trim().is_empty()),
        service_count: optional_u64_field(data, &["serviceCount"]),
        instance_count: optional_u64_field(data, &["instanceCount"]),
        subscribe_count: optional_u64_field(data, &["subscribeCount"]),
        raft_notify_task_count: optional_u64_field(data, &["raftNotifyTaskCount"]),
        responsible_service_count: optional_u64_field(data, &["responsibleServiceCount"]),
        responsible_instance_count: optional_u64_field(data, &["responsibleInstanceCount"]),
        client_count: optional_u64_field(data, &["clientCount"]),
        connection_based_client_count: optional_u64_field(data, &["connectionBasedClientCount"]),
        ephemeral_ip_port_client_count: optional_u64_field(data, &["ephemeralIpPortClientCount"]),
        persistent_ip_port_client_count: optional_u64_field(data, &["persistentIpPortClientCount"]),
        responsible_client_count: optional_u64_field(data, &["responsibleClientCount"]),
        cpu: optional_f64_field(data, &["cpu"]),
        load: optional_f64_field(data, &["load"]),
        mem: optional_f64_field(data, &["mem"]),
    }
}

fn merge_prometheus_dashboard(
    metrics: &mut Option<NacosDashboardMetrics>,
    prometheus: Option<&NacosPrometheusSnapshot>,
) {
    let Some(prometheus) = prometheus else {
        return;
    };
    let metrics = metrics.get_or_insert_with(NacosDashboardMetrics::default);
    if let Some(value) = finite_u64(prometheus.naming.instance_count) {
        metrics.instance_count = Some(value);
    }
    if let Some(value) = finite_u64(prometheus.naming.subscriber_count) {
        metrics.subscribe_count = Some(value);
    }
    if let Some(value) = finite_u64(prometheus.naming.connection_count) {
        metrics.client_count = Some(value);
        metrics.connection_based_client_count = Some(value);
    }
    if let Some(value) = prometheus.resource.cpu_ratio {
        metrics.cpu = Some(value);
    }
    if let Some(value) = prometheus.resource.memory_ratio {
        metrics.mem = Some(value);
    }
    if let Some(value) = prometheus.resource.load_1m {
        metrics.load = Some(value);
    }
}

fn finite_u64(value: Option<f64>) -> Option<u64> {
    value.filter(|value| value.is_finite() && *value >= 0.0 && *value <= u64::MAX as f64).map(|value| value as u64)
}

fn parse_cluster_nodes(value: Value) -> Vec<NacosClusterNode> {
    let data = value.get("data").unwrap_or(&value);
    let items = data
        .as_array()
        .cloned()
        .or_else(|| data.get("servers").and_then(Value::as_array).cloned())
        .or_else(|| data.get("members").and_then(Value::as_array).cloned())
        .or_else(|| data.get("nodes").and_then(Value::as_array).cloned())
        .or_else(|| data.get("pageItems").and_then(Value::as_array).cloned())
        .or_else(|| value.get("servers").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    items
        .into_iter()
        .map(|item| {
            let ip = optional_string_field(&item, &["ip"]);
            let port = optional_u64_field(&item, &["port", "servePort"]).and_then(|port| u16::try_from(port).ok());
            let address = optional_string_field(&item, &["address", "key"])
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| match (&ip, port) {
                    (Some(ip), Some(port)) => format!("{ip}:{port}"),
                    (Some(ip), None) => ip.clone(),
                    _ => "-".to_string(),
                });
            let state = optional_string_field(&item, &["state", "status"]);
            let alive = optional_bool_field(&item, &["alive", "healthy"]).or_else(|| {
                state.as_ref().map(|state| matches!(state.to_ascii_uppercase().as_str(), "UP" | "ONLINE" | "HEALTHY"))
            });
            NacosClusterNode {
                address,
                ip,
                port,
                state,
                alive,
                site: optional_string_field(&item, &["site"]),
                weight: optional_f64_field(&item, &["weight", "adWeight"]),
                last_refresh_time: optional_string_field(&item, &["lastRefreshTime", "lastRefTimeStr", "lastRefTime"])
                    .or_else(|| {
                        item.get("extendInfo")
                            .and_then(|extend_info| optional_string_field(extend_info, &["lastRefreshTime"]))
                    }),
            }
        })
        .collect()
}

fn normalize_api_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn looks_like_wrong_context_path(detail: &str, context_path: &str) -> bool {
    let context = context_path.trim().trim_matches('/');
    if context.is_empty() {
        return false;
    }
    let detail = detail.to_ascii_lowercase();
    let context = context.to_ascii_lowercase();
    detail.contains(&format!("no static resource {context}/"))
        || detail.contains(&format!("path\":\"/{context}/"))
        || detail.contains(&format!("path=/{context}/"))
}

fn admin_endpoint_error(server_addr: &str, errors: &[String]) -> String {
    let joined = errors.join("\n");
    let lower = joined.to_ascii_lowercase();
    if lower.contains("404 not found") && (lower.contains("<!doctype html>") || lower.contains("<html")) {
        return classified_error(
            "endpointNotFound",
            &format!(
                "Nacos admin endpoint was not found at {server_addr}. This looks like a Nacos client/server port, not a management endpoint. Check the selected Nacos profile and use the endpoint exposed by that deployment."
            ),
        );
    }
    classified_error(
        classify_nacos_error(&joined),
        &format!("Failed to detect Nacos admin endpoint at {server_addr}: {}", joined.trim()),
    )
}

fn push_optional(params: &mut Vec<(String, String)>, key: &str, value: Option<String>) {
    if let Some(value) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        params.push((key.to_string(), value));
    }
}

type NacosForm = Vec<(String, String)>;

fn build_publish_forms(req: NacosConfigUpsert, namespace: String) -> (NacosForm, NacosForm) {
    let mut v3_form = vec![
        ("dataId".to_string(), req.data_id.clone()),
        ("groupName".to_string(), req.group.clone()),
        ("content".to_string(), req.content.clone()),
        ("namespaceId".to_string(), namespace.clone()),
    ];
    push_optional(&mut v3_form, "type", req.config_type.clone());
    push_optional(&mut v3_form, "appName", req.app_name.clone());
    push_optional(&mut v3_form, "desc", req.desc.clone());
    push_optional(&mut v3_form, "configTags", req.tags.clone());
    push_optional(&mut v3_form, "config_tags", req.tags.clone());

    let mut v1_form = vec![
        ("dataId".to_string(), req.data_id),
        ("group".to_string(), req.group),
        ("content".to_string(), req.content),
        ("tenant".to_string(), namespace),
    ];
    push_optional(&mut v1_form, "type", req.config_type);
    push_optional(&mut v1_form, "appName", req.app_name);
    push_optional(&mut v1_form, "desc", req.desc);
    push_optional(&mut v1_form, "config_tags", req.tags);

    (v3_form, v1_form)
}

#[cfg(test)]
fn namespace_list_error(v3_err: &str, v1_err: &str) -> String {
    let message = format!("Failed to list Nacos namespaces with v3 and v1 APIs. v3: {v3_err}; v1: {v1_err}");
    classified_error(classify_nacos_error(&message), &message)
}

async fn response_json_or_text(resp: reqwest::Response) -> Result<Value, String> {
    let bytes = resp.bytes().await.map_err(|e| format!("Failed to read Nacos response: {e}"))?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string())))
}

fn rnacos_namespace_directory_endpoint_unavailable(error: &str) -> bool {
    ["404 Not Found", "405 Method Not Allowed", "410 Gone"]
        .iter()
        .any(|status| error.contains(&format!("returned {status}")))
}

async fn error_for_status(resp: reqwest::Response, path: &str) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let detail = resp.text().await.unwrap_or_default();
    let detail = compact_response_detail(&detail);
    let message = if detail.is_empty() {
        format!("Nacos admin {path} returned {status}")
    } else {
        format!("Nacos admin {path} returned {status}: {detail}")
    };
    Err(classified_error(classify_nacos_error(&message), &message))
}

fn compact_response_detail(detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        return String::new();
    }
    if detail.to_ascii_lowercase().contains("<!doctype html") || detail.to_ascii_lowercase().contains("<html") {
        return "HTML error page".to_string();
    }

    const MAX_CHARS: usize = 512;
    let mut chars = detail.chars();
    let compact: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{compact}…")
    } else {
        compact
    }
}

fn classified_error(kind: &str, message: &str) -> String {
    format!("{NACOS_ERROR_PREFIX}[{kind}]: {message}")
}

fn is_official_session_expired(message: &str) -> bool {
    message.to_ascii_lowercase().contains("session expired")
}

fn classify_nacos_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("403")
        || lower.contains("401")
        || lower.contains("invalid username")
        || lower.contains("invalid password")
        || lower.contains("access token")
        || lower.contains("authentication")
    {
        return "authFailed";
    }
    if lower.contains("no static resource") || lower.contains("context path") {
        return "contextPathMismatch";
    }
    if lower.contains("history")
        && (lower.contains("unsupportedconfighistory") || lower.contains("not found") || lower.contains("404"))
    {
        return "unsupportedConfigHistory";
    }
    if lower.contains("410 gone")
        || lower.contains("405 method not allowed")
        || lower.contains("not found")
        || lower.contains("404")
    {
        return "apiVersionMismatch";
    }
    if lower.contains("connection refused")
        || lower.contains("failed to connect")
        || lower.contains("timed out")
        || lower.contains("dns error")
        || lower.contains("nodename nor servname")
    {
        return "connectionFailed";
    }
    "requestFailed"
}

fn validate_nacos_json_authorization(value: &Value, path: &str) -> Result<(), String> {
    let code = value.get("code").and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse::<i64>().ok()));
    if !matches!(code, Some(403 | 10001)) {
        return Ok(());
    }
    let message = value.get("message").and_then(Value::as_str).unwrap_or("access denied");
    let detail = value.get("data").and_then(Value::as_str).unwrap_or_default();
    let detail = format!("Nacos {path} returned code {}: {message} {detail}", code.unwrap_or_default());
    Err(classified_error("authFailed", detail.trim()))
}

fn extract_server_version(raw: &Value) -> Option<String> {
    raw.get("version")
        .or_else(|| raw.get("serverVersion"))
        .or_else(|| raw.pointer("/servers/0/version"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn parse_config_list(value: Value, namespace: String, page_no: u32, page_size: u32) -> NacosConfigList {
    let data = value.get("data").unwrap_or(&value);
    let total_count = data
        .get("totalCount")
        .or_else(|| data.get("total"))
        .or_else(|| data.get("count"))
        .or_else(|| value.get("totalCount"))
        .or_else(|| value.get("total"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let items: Vec<NacosConfigItem> = data
        .get("pageItems")
        .or_else(|| data.get("items"))
        .or_else(|| data.get("list"))
        .or_else(|| value.get("pageItems"))
        .or_else(|| value.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| NacosConfigItem {
            data_id: string_field(&item, &["dataId", "data_id"]),
            group: string_field(&item, &["group", "groupName"]),
            namespace: string_field(&item, &["tenant", "namespaceId"]).if_empty(&namespace),
            app_name: optional_string_field(&item, &["appName", "app_name"]),
            desc: optional_string_field(&item, &["desc", "description", "configDesc", "config_desc"]),
            tags: optional_string_field(&item, &["tags", "configTags", "config_tags"]),
            config_type: config_format_for_item(&item),
            md5: optional_string_field(&item, &["md5"]),
            encrypted_data_key: optional_string_field(&item, &["encryptedDataKey"]),
            content: optional_string_field(&item, &["content"]),
        })
        .collect();
    NacosConfigList { page_no, page_size, total_count, items }
}

fn parse_config_detail(value: Value, data_id: String, group: String, namespace: String) -> NacosConfigItem {
    let data = value.get("data").filter(|value| value.is_object()).unwrap_or(&value);
    NacosConfigItem {
        data_id: string_field(data, &["dataId", "data_id"]).if_empty(&data_id),
        group: string_field(data, &["group", "groupName"]).if_empty(&group),
        namespace: string_field(data, &["tenant", "namespaceId"]).if_empty(&namespace),
        app_name: optional_string_field(data, &["appName", "app_name"]),
        desc: optional_string_field(data, &["desc", "description", "configDesc", "config_desc"]),
        tags: optional_string_field(data, &["tags", "configTags", "config_tags"]),
        config_type: config_format_for_item(data).or_else(|| infer_config_format(&data_id)),
        md5: optional_string_field(data, &["md5"]),
        encrypted_data_key: optional_string_field(data, &["encryptedDataKey"]),
        // Prefer string fields only. Try each key so null `content` does not hide `value`.
        content: ["content", "value", "configValue", "config_value"]
            .iter()
            .find_map(|key| data.get(*key).and_then(Value::as_str).map(str::to_string))
            .or_else(|| value.as_str().map(str::to_string)),
    }
}

fn parse_config_history_list(
    value: Value,
    namespace: String,
    page_no: u32,
    page_size: u32,
    data_id: &str,
    group: &str,
) -> NacosConfigHistoryList {
    let data = value.get("data").unwrap_or(&value);
    let direct_items = if data.is_array() { data.as_array() } else { value.as_array() };
    let total_count = data
        .get("totalCount")
        .or_else(|| data.get("total"))
        .or_else(|| data.get("count"))
        .or_else(|| value.get("totalCount"))
        .or_else(|| value.get("total"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let items: Vec<NacosConfigHistoryItem> = data
        .get("pageItems")
        .or_else(|| data.get("items"))
        .or_else(|| data.get("list"))
        .or_else(|| value.get("pageItems"))
        .or_else(|| value.get("items"))
        .and_then(Value::as_array)
        .or(direct_items)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| parse_config_history_item(item, &namespace, data_id, group))
        .collect();
    let total_count = if total_count == 0 { items.len() as u64 } else { total_count };
    NacosConfigHistoryList { page_no, page_size, total_count, items }
}

fn parse_config_history_item(
    item: Value,
    namespace: &str,
    fallback_data_id: &str,
    fallback_group: &str,
) -> NacosConfigHistoryItem {
    let history_id = optional_string_field(&item, &["id", "historyId", "nid"])
        .or_else(|| optional_i64_field(&item, &["id", "historyId", "nid"]).map(|value| value.to_string()))
        .unwrap_or_default();
    NacosConfigHistoryItem {
        history_id,
        nid: optional_i64_field(&item, &["nid"]).or_else(|| optional_i64_field(&item, &["id", "historyId"])),
        data_id: string_field(&item, &["dataId", "data_id"]).if_empty(fallback_data_id),
        group: string_field(&item, &["group", "groupName"]).if_empty(fallback_group),
        namespace: string_field(&item, &["tenant", "namespaceId"]).if_empty(namespace),
        app_name: optional_string_field(&item, &["appName", "app_name"]),
        operation: optional_string_field(&item, &["opType", "operation", "operateType", "type"]),
        operator: optional_string_field(&item, &["operator", "opUser", "srcUser", "createUser", "modifyUser", "user"]),
        last_modified_time: optional_string_field(
            &item,
            &[
                "lastModifiedTime",
                "lastModifiedTs",
                "lastModified",
                "last_modified_time",
                "last_modified",
                "gmtModified",
                "gmt_modified",
                "modifiedTime",
                "modifyTime",
                "updateTime",
                "update_time",
                "publishTime",
                "publish_time",
                "opTime",
                "createdTime",
                "createTime",
                "create_time",
            ],
        )
        .or_else(|| {
            optional_u64_field(
                &item,
                &[
                    "lastModifiedTime",
                    "lastModifiedTs",
                    "lastModified",
                    "last_modified_time",
                    "last_modified",
                    "gmtModified",
                    "gmt_modified",
                    "modifiedTime",
                    "modifyTime",
                    "updateTime",
                    "update_time",
                    "publishTime",
                    "publish_time",
                    "opTime",
                    "createdTime",
                    "createTime",
                    "create_time",
                ],
            )
            .map(|value| value.to_string())
        }),
        config_type: config_format_for_item(&item),
        tags: optional_string_field(&item, &["tags", "configTags", "config_tags"]),
        md5: optional_string_field(&item, &["md5"]),
    }
}

fn parse_config_history_detail(value: Value, data_id: String, group: String, namespace: String) -> NacosConfigItem {
    parse_config_detail(value, data_id, group, namespace)
}

fn rnacos_history_item(value: &Value, history_id: &str, nid: Option<i64>) -> Option<Value> {
    let data = value.get("data").unwrap_or(value);
    data.get("list")
        .or_else(|| data.get("items"))
        .or_else(|| value.get("list"))
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                let item_id = optional_string_field(item, &["id", "historyId", "nid"])
                    .or_else(|| optional_i64_field(item, &["id", "historyId", "nid"]).map(|value| value.to_string()));
                item_id.as_deref() == Some(history_id)
                    || nid.is_some_and(|nid| optional_i64_field(item, &["id", "historyId", "nid"]) == Some(nid))
            })
        })
        .cloned()
}

fn rnacos_console_error_detail(value: &Value) -> String {
    // Console error bodies are not a trusted display surface: deployments may
    // echo request fields or tokens. Keep the client-visible detail generic.
    let _ = value;
    "request rejected".to_string()
}

fn rnacos_console_session_expired(value: &Value) -> bool {
    ["code", "message", "msg"]
        .into_iter()
        .filter_map(|key| value.get(key).and_then(Value::as_str))
        .any(|value| value.eq_ignore_ascii_case("NO_LOGIN"))
}

/// r-nacos uses a plain Base64 password when no CAPTCHA is active. When a
/// CAPTCHA token is present, its first 16 bytes are the AES-128-CBC key and
/// the following 16 bytes are the IV; the resulting ciphertext is Base64
/// encoded before it is submitted as a form field.
fn rnacos_console_password(password: &str, captcha_token: Option<&str>) -> Result<String, String> {
    let Some(captcha_token) = captcha_token else {
        return Ok(BASE64.encode(password.as_bytes()));
    };
    let captcha_token = captcha_token.as_bytes();
    let key = captcha_token
        .get(..16)
        .ok_or_else(|| "r-nacos console CAPTCHA token is shorter than the encryption key".to_string())?;
    let iv = captcha_token
        .get(16..32)
        .ok_or_else(|| "r-nacos console CAPTCHA token is shorter than the encryption IV".to_string())?;
    let plaintext = password.as_bytes();
    let buffer_len = plaintext.len().saturating_add(16);
    let mut buffer = vec![0u8; buffer_len];
    let encrypted = Aes128CbcEncryptor::<aes::Aes128>::new(key.into(), iv.into())
        .encrypt_padded_b2b_mut::<Pkcs7>(plaintext, &mut buffer)
        .map_err(|error| format!("Failed to encrypt r-nacos console password: {error}"))?;
    Ok(BASE64.encode(encrypted))
}

fn parse_service_list(value: Value, page_no: u32, page_size: u32) -> NacosServiceList {
    let data = value.get("data").unwrap_or(&value);
    let total_count = data
        .get("count")
        .or_else(|| data.get("totalCount"))
        .or_else(|| data.get("total"))
        .or_else(|| value.get("count"))
        .or_else(|| value.get("totalCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let items_value = data
        .get("doms")
        .or_else(|| data.get("serviceList"))
        .or_else(|| data.get("services"))
        .or_else(|| data.get("list"))
        .or_else(|| data.get("pageItems"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("doms"))
        .or_else(|| value.get("serviceList"))
        .or_else(|| value.get("services"))
        .or_else(|| value.get("list"))
        .or_else(|| value.get("pageItems"));
    let items: Vec<NacosServiceInfo> = items_value
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            if let Some(name) = item.as_str() {
                let (group_name, service_name) = split_nacos_service_name(name);
                NacosServiceInfo {
                    service_name,
                    group_name,
                    cluster_count: None,
                    ip_count: None,
                    healthy_instance_count: None,
                    trigger_flag: None,
                }
            } else {
                let raw_name = string_field(&item, &["name", "serviceName"]);
                let (embedded_group_name, service_name) = split_nacos_service_name(&raw_name);
                NacosServiceInfo {
                    service_name,
                    group_name: optional_string_field(&item, &["groupName"]).or(embedded_group_name),
                    cluster_count: optional_u64_field(&item, &["clusterCount"]),
                    ip_count: optional_u64_field(&item, &["ipCount"]),
                    healthy_instance_count: optional_u64_field(&item, &["healthyInstanceCount"]),
                    trigger_flag: optional_string_field(&item, &["triggerFlag"]),
                }
            }
        })
        .collect();
    let total_count = if total_count == 0 { items.len() as u64 } else { total_count };
    NacosServiceList { page_no, page_size, total_count, items }
}

fn parse_service_detail(value: Value) -> NacosServiceDetail {
    let data = value.get("data").unwrap_or(&value);
    let raw_name = string_field(data, &["name", "serviceName"]);
    let (embedded_group_name, service_name) = split_nacos_service_name(&raw_name);
    NacosServiceDetail {
        service_name,
        group_name: optional_string_field(data, &["groupName"]).or(embedded_group_name),
        metadata: data.get("metadata").cloned().unwrap_or(Value::Null),
        protect_threshold: data.get("protectThreshold").and_then(Value::as_f64),
        selector: data.get("selector").cloned().filter(|value| !value.is_null()),
        ephemeral: data.get("ephemeral").and_then(Value::as_bool),
    }
}

fn instance_ref_form(namespace: String, target: NacosInstanceRef) -> Vec<(String, String)> {
    let mut form = vec![
        ("serviceName".to_string(), target.service_name),
        ("ip".to_string(), target.ip),
        ("port".to_string(), target.port.to_string()),
        ("namespaceId".to_string(), namespace),
    ];
    push_optional(&mut form, "groupName", target.group_name);
    push_optional(&mut form, "clusterName", target.cluster_name);
    if let Some(value) = target.ephemeral {
        form.push(("ephemeral".to_string(), value.to_string()));
    }
    form
}

fn instance_update_form(namespace: String, req: NacosInstanceUpdateRequest) -> Vec<(String, String)> {
    let mut form = instance_ref_form(namespace, req.target);
    if let Some(value) = req.patch.healthy {
        form.push(("healthy".to_string(), value.to_string()));
    }
    if let Some(value) = req.patch.enabled {
        form.push(("enabled".to_string(), value.to_string()));
    }
    if let Some(value) = req.patch.weight {
        if value.is_finite() && value >= 0.0 {
            form.push(("weight".to_string(), value.to_string()));
        }
    }
    if let Some(value) = req.patch.metadata {
        if value.is_object() {
            form.push(("metadata".to_string(), value.to_string()));
        }
    }
    form
}

fn instance_registration_form(namespace: String, req: NacosInstanceRegistration) -> Vec<(String, String)> {
    let target = NacosInstanceRef {
        namespace: req.namespace,
        service_name: req.service_name,
        ip: req.ip,
        port: req.port,
        group_name: req.group_name,
        cluster_name: req.cluster_name,
        ephemeral: Some(false),
    };
    let mut form = instance_ref_form(namespace, target);
    if let Some(value) = req.weight {
        if value.is_finite() && value >= 0.0 {
            form.push(("weight".to_string(), value.to_string()));
        }
    }
    if let Some(value) = req.metadata {
        if value.is_object() {
            form.push(("metadata".to_string(), value.to_string()));
        }
    }
    form
}

fn split_nacos_service_name(value: &str) -> (Option<String>, String) {
    let trimmed = value.trim();
    if let Some((group, name)) = trimmed.split_once("@@") {
        let group = group.trim();
        let name = name.trim();
        if !group.is_empty() && !name.is_empty() {
            return (Some(group.to_string()), name.to_string());
        }
    }
    (None, trimmed.to_string())
}

fn split_nacos_cluster_names(value: Option<&str>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter(|name| seen.insert((*name).to_string()))
        .map(str::to_string)
        .collect()
}

fn filter_instances_by_clusters(
    instances: Vec<NacosInstanceInfo>,
    requested_clusters: &[String],
) -> Vec<NacosInstanceInfo> {
    if requested_clusters.is_empty() {
        return instances;
    }
    instances
        .into_iter()
        .filter(|instance| {
            instance
                .cluster_name
                .as_deref()
                .is_some_and(|cluster| requested_clusters.iter().any(|requested| requested == cluster))
        })
        .collect()
}

fn deduplicate_management_instances(
    mut instances: Vec<NacosInstanceInfo>,
    namespace: &str,
    group_name: Option<&str>,
    service_name: &str,
) -> Vec<NacosInstanceInfo> {
    let mut seen = HashSet::new();
    let default_group = group_name.unwrap_or("DEFAULT_GROUP").to_string();
    let service_name = service_name.to_string();
    instances.retain(|instance| {
        seen.insert((
            namespace,
            instance.group_name.clone().unwrap_or_else(|| default_group.clone()),
            instance.service_name.clone().unwrap_or_else(|| service_name.clone()),
            instance.ip.clone(),
            instance.port,
            instance.cluster_name.clone(),
            instance.ephemeral,
        ))
    });
    instances
}

fn parse_catalog_cluster_names(value: &Value) -> Vec<String> {
    let data = value.get("data").unwrap_or(value);
    let mut seen = HashSet::new();
    let mut names: Vec<String> = data
        .get("clusters")
        .or_else(|| value.get("clusters"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|cluster| optional_string_field(cluster, &["name", "clusterName"]))
        .filter(|name| seen.insert(name.clone()))
        .collect();
    if let Some(cluster_map) = data.get("clusterMap").and_then(Value::as_object) {
        names.extend(cluster_map.keys().filter(|name| seen.insert((*name).clone())).cloned());
    }
    names
}

fn catalog_instance_count(value: &Value) -> Option<u64> {
    let data = value.get("data").unwrap_or(value);
    data.get("count")
        .or_else(|| data.get("totalCount"))
        .or_else(|| data.get("total"))
        .or_else(|| value.get("count"))
        .or_else(|| value.get("totalCount"))
        .and_then(Value::as_u64)
}

fn parse_instances(value: Value) -> Vec<NacosInstanceInfo> {
    let data = value.get("data").unwrap_or(&value);
    let items = data
        .get("hosts")
        .or_else(|| data.get("instances"))
        .or_else(|| data.get("list"))
        .or_else(|| data.get("pageItems"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("hosts"))
        .or_else(|| value.get("instances"))
        .or_else(|| value.get("list"))
        .and_then(Value::as_array)
        .cloned()
        // Nacos 3 Naming Admin returns `data` as the instance array directly,
        // unlike the v1/v2 `hosts` and Catalog `list` wrappers.
        .or_else(|| data.as_array().cloned())
        .or_else(|| data.is_object().then(|| vec![data.clone()]))
        .unwrap_or_default();
    items
        .into_iter()
        .filter(|item| item.get("ip").is_some() && item.get("port").is_some())
        .map(parse_instance)
        .collect()
}

fn parse_instance(item: Value) -> NacosInstanceInfo {
    NacosInstanceInfo {
        ip: string_field(&item, &["ip"]),
        port: item.get("port").and_then(Value::as_u64).unwrap_or(0) as u16,
        service_name: optional_string_field(&item, &["serviceName"]),
        cluster_name: optional_string_field(&item, &["clusterName"]),
        group_name: optional_string_field(&item, &["groupName"]),
        healthy: item.get("healthy").and_then(Value::as_bool),
        enabled: item.get("enabled").and_then(Value::as_bool),
        ephemeral: item.get("ephemeral").and_then(Value::as_bool),
        weight: item.get("weight").and_then(Value::as_f64),
        metadata: item.get("metadata").cloned().unwrap_or(Value::Null),
    }
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    optional_string_field(value, keys).unwrap_or_default()
}

fn optional_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|v| v.to_string()))
                .or_else(|| value.as_u64().map(|v| v.to_string()))
                .or_else(|| value.as_bool().map(|v| v.to_string()))
        })
        .filter(|value| !value.is_empty())
}

fn config_format_for_item(item: &Value) -> Option<String> {
    optional_string_field(
        item,
        &[
            "type",
            "configType",
            "config_type",
            "configFormat",
            "config_format",
            "configTypeName",
            "config_type_name",
            "format",
            "contentType",
            "content_type",
            "fileType",
            "file_type",
        ],
    )
    .or_else(|| optional_string_field(item, &["dataId", "data_id"]).and_then(|data_id| infer_config_format(&data_id)))
    .map(normalize_config_format)
}

fn infer_config_format(data_id: &str) -> Option<String> {
    let name = data_id.trim().to_ascii_lowercase();
    let ext = name.rsplit_once('.').map(|(_, ext)| ext)?;
    match ext {
        "yaml" | "yml" => Some("yaml".to_string()),
        "json" => Some("json".to_string()),
        "xml" => Some("xml".to_string()),
        "html" | "htm" => Some("html".to_string()),
        "properties" | "props" => Some("properties".to_string()),
        "txt" | "text" => Some("text".to_string()),
        _ => None,
    }
}

fn normalize_config_format(value: String) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "txt" => "text".to_string(),
        "yml" => "yaml".to_string(),
        "props" => "properties".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => value,
    }
}

fn optional_u64_field(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| value.get(*key)).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    })
}

fn optional_f64_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| value.as_f64().or_else(|| value.as_str().and_then(|value| value.trim().parse().ok())))
        .filter(|value| value.is_finite())
}

fn optional_bool_field(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|key| value.get(*key)).and_then(|value| {
        value.as_bool().or_else(|| match value.as_str()?.trim().to_ascii_lowercase().as_str() {
            "true" | "up" | "online" | "healthy" => Some(true),
            "false" | "down" | "offline" | "unhealthy" => Some(false),
            _ => None,
        })
    })
}

fn optional_i64_field(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| value.as_i64().or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok())))
}

fn response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value): (&reqwest::header::HeaderName, &HeaderValue)| {
            value.to_str().ok().map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

trait EmptyFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                });
                if content_length.is_none_or(|length| request.len() >= header_end + 4 + length) {
                    break;
                }
            }
        }
        String::from_utf8(request).unwrap()
    }

    async fn read_request_target(socket: &mut tokio::net::TcpStream) -> String {
        let request = read_http_request(socket).await;
        request.split_whitespace().nth(1).unwrap().to_string()
    }

    fn request_form_value<'a>(request: &'a str, key: &str) -> Option<&'a str> {
        let body = request.split_once("\r\n\r\n")?.1;
        body.split('&').find_map(|entry| {
            let (entry_key, value) = entry.split_once('=')?;
            (entry_key == key).then_some(value)
        })
    }

    async fn write_json_response(socket: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn write_json_response_with_cookie(socket: &mut tokio::net::TcpStream, body: &str, cookie: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: {cookie}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn accept_json_request(listener: &tokio::net::TcpListener, body: &str) -> String {
        let (mut socket, _) = listener.accept().await.unwrap();
        let target = read_request_target(&mut socket).await;
        write_json_response(&mut socket, body).await;
        target
    }

    async fn write_text_response(socket: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn write_json_response_with_captcha_token(socket: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCaptcha-Token: 1234567890abcdeffedcba0987654321\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn write_not_found_response(socket: &mut tokio::net::TcpStream) {
        const BODY: &str = "not found";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
            BODY.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn write_forbidden_response(socket: &mut tokio::net::TcpStream) {
        const BODY: &str = "invalid username or password";
        let response = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
            BODY.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    async fn write_service_unavailable_response(socket: &mut tokio::net::TcpStream) {
        const BODY: &str = "temporarily unavailable";
        let response = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
            BODY.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    fn test_admin_config(server_addr: String) -> NacosAdminConfig {
        NacosAdminConfig {
            implementation: None,
            version_mode: None,
            api_plane: None,
            server_addr: server_addr.clone(),
            display_server_addr: server_addr,
            namespace: String::new(),
            context_path: String::new(),
            managed_namespaces: Vec::new(),
            rnacos_console_addr: String::new(),
            rnacos_history_enabled: None,
            rnacos_console_auth: Default::default(),
            auth: NacosAuthConfig::None,
            tls_skip_verify: false,
            metrics_mode: Default::default(),
            metrics_url: String::new(),
            page_size: 100,
            connect_override: None,
        }
    }

    #[tokio::test]
    async fn v3_namespace_list_uses_managed_namespaces_after_admin_denial() {
        let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_address = api_listener.local_addr().unwrap();
        let api_server = tokio::spawn(async move {
            let (mut socket, _) = api_listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/auth/user/login");
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000}}"#)
                .await;
            let (mut socket, _) = api_listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert_eq!(target, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut socket,
                r#"{"code":10001,"message":"access denied","data":"Code: 403, Message: authorization failed!."}"#,
            )
            .await;
        });

        let mut config = test_admin_config(format!("http://{api_address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.managed_namespaces = vec!["team-a".to_string(), "public".to_string()];
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let namespaces = admin.list_namespaces().await.unwrap();
        assert!(namespaces.iter().any(|namespace| namespace.namespace == "team-a"));
        assert!(namespaces.iter().any(|namespace| namespace.namespace == "public"));
        api_server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_namespace_list_requires_managed_namespaces_after_admin_denial() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/auth/user/login");
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000}}"#)
                .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut socket,
                r#"{"code":10001,"message":"access denied","data":"Code: 403, Message: authorization failed!."}"#,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let target = request.split_whitespace().nth(1).unwrap();
            assert!(target.starts_with("/nacos/v1/console/namespaces?"));
            assert!(target.contains("accessToken=ordinary-token"));
            assert!(!request.to_ascii_lowercase().contains("\r\naccesstoken:"));
            write_json_response(&mut socket, r#"{"code":403,"message":"authorization failed","data":"access denied"}"#)
                .await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        let error = NacosOpenApiAdmin::new(config).unwrap().list_namespaces().await.unwrap_err();

        assert!(error.contains("NACOS_ERROR[managedNamespacesRequired]"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_namespace_list_uses_console_directory_after_admin_denial() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/auth/user/login");
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000}}"#)
                .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut socket,
                r#"{"code":10001,"message":"access denied","data":"Code: 403, Message: authorization failed!."}"#,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let target = request.split_whitespace().nth(1).unwrap();
            assert!(target.starts_with("/nacos/v1/console/namespaces?"));
            assert!(target.contains("accessToken=ordinary-token"));
            assert!(!request.to_ascii_lowercase().contains("\r\naccesstoken:"));
            write_json_response(
                &mut socket,
                r#"{"data":[{"namespace":"f8b8c4e2-8195-4041-adb2-683a8259384b","namespaceShowName":"bb"}]}"#,
            )
            .await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        let namespaces = NacosOpenApiAdmin::new(config).unwrap().list_namespaces().await.unwrap();

        assert!(namespaces.iter().any(|namespace| {
            namespace.namespace == "f8b8c4e2-8195-4041-adb2-683a8259384b" && namespace.namespace_show_name == "bb"
        }));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_namespace_list_requires_managed_namespaces_after_admin_denial() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"ordinary-token","tokenTtl":18000}"#).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/console/namespaces?"));
            write_json_response(&mut socket, r#"{"code":403,"message":"authorization failed","data":"access denied"}"#)
                .await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        let error = NacosOpenApiAdmin::new(config).unwrap().list_namespaces().await.unwrap_err();

        assert!(error.contains("NACOS_ERROR[managedNamespacesRequired]"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_namespace_list_uses_explicit_scope_after_admin_denial() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"ordinary-token","tokenTtl":18000}"#).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/nacos/v1/console/namespaces?"));
            assert!(target.contains("accessToken=ordinary-token"));
            write_json_response(&mut socket, r#"{"code":403,"message":"authorization failed","data":"access denied"}"#)
                .await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string(), "public".to_string()];

        let namespaces = NacosOpenApiAdmin::new(config).unwrap().list_namespaces().await.unwrap();
        assert_eq!(
            namespaces.into_iter().map(|namespace| namespace.namespace).collect::<Vec<_>>(),
            vec!["team-a".to_string(), "public".to_string()]
        );
        server.await.unwrap();
    }

    #[test]
    fn official_nacos_v2_ordinary_users_can_define_an_explicit_namespace_scope() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string(), "public".to_string()];

        assert_eq!(
            NacosOpenApiAdmin::new(config).unwrap().explicitly_scoped_namespace_ids(),
            Some(vec!["team-a".to_string(), "public".to_string()])
        );
    }

    #[test]
    fn recognizes_v3_authorization_errors_returned_inside_http_200_json() {
        let error = validate_nacos_json_authorization(
            &serde_json::json!({"code":10001,"message":"access denied","data":"Code: 403, Message: authorization failed!."}),
            "/v3/admin/cs/config/list",
        )
        .unwrap_err();

        assert!(error.contains("NACOS_ERROR[authFailed]"));
        assert!(error.contains("authorization failed"));
        assert!(
            validate_nacos_json_authorization(&serde_json::json!({"code":0,"message":"success"}), "success").is_ok()
        );
    }

    #[tokio::test]
    async fn version_mode_v2_uses_only_v1_config_paths() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/cs/configs?"));
            write_json_response(&mut socket, r#"{"totalCount":0,"pageItems":[]}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin.get_config_list_value("", "", "", "", 1, 20).await.unwrap();
        server.await.unwrap();
    }

    async fn assert_group_filter_uses_client_side_contains_match(
        implementation: Option<NacosImplementation>,
        version_mode: Option<NacosVersionMode>,
        expected_path: &str,
        group_param: &str,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let expected_path = expected_path.to_string();
        let group_param = group_param.to_string();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), expected_path);
            assert_eq!(params.get(group_param.as_str()).map(|value| value.as_ref()), Some(""));
            write_json_response(
                &mut socket,
                r#"{"totalCount":2,"pageItems":[{"dataId":"service.yaml","group":"SENSITIVE_GROUP","tenant":"ops","type":"yaml"},{"dataId":"other.yaml","group":"DEFAULT_GROUP","tenant":"ops","type":"yaml"}]}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = implementation;
        config.version_mode = version_mode;
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let list = admin
            .list_configs(NacosConfigQuery {
                namespace: Some("ops".to_string()),
                group: Some("sensitive".to_string()),
                group_contains: true,
                data_id: None,
                app_name: None,
                search: None,
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();

        assert_eq!(list.total_count, 1);
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].group, "SENSITIVE_GROUP");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn group_filter_uses_consistent_client_side_contains_matching() {
        assert_group_filter_uses_client_side_contains_match(
            None,
            Some(NacosVersionMode::V2),
            "/nacos/v1/cs/configs",
            "group",
        )
        .await;
        assert_group_filter_uses_client_side_contains_match(
            None,
            Some(NacosVersionMode::V3),
            "/nacos/v3/admin/cs/config/list",
            "groupName",
        )
        .await;
        assert_group_filter_uses_client_side_contains_match(
            Some(NacosImplementation::RNacos),
            None,
            "/nacos/v1/cs/configs",
            "group",
        )
        .await;
    }

    #[tokio::test]
    async fn exact_group_filter_keeps_server_side_matching() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), "/nacos/v3/admin/cs/config/list");
            assert_eq!(params.get("groupName").map(|value| value.as_ref()), Some("SENSITIVE_GROUP"));
            assert_eq!(params.get("dataId").map(|value| value.as_ref()), Some("service.yaml"));
            write_json_response(
                &mut socket,
                r#"{"code":0,"data":{"totalCount":1,"pageItems":[{"dataId":"service.yaml","groupName":"SENSITIVE_GROUP","namespaceId":"ops","type":"yaml"}]}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let list = admin
            .list_configs(NacosConfigQuery {
                namespace: Some("ops".to_string()),
                group: Some("SENSITIVE_GROUP".to_string()),
                group_contains: false,
                data_id: Some("service.yaml".to_string()),
                app_name: None,
                search: None,
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();

        assert_eq!(list.total_count, 1);
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].group, "SENSITIVE_GROUP");
        server.await.unwrap();
    }

    #[test]
    fn explicit_v3_rejects_legacy_admin_api_paths() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert!(admin.api_path_allowed("/v3/admin/ns/ops/metrics"));
        assert!(admin.api_path_allowed("/health"));
        assert!(!admin.api_path_allowed("/v3/console/cs/config/list"));
        assert!(!admin.api_path_allowed("/v2/ns/operator/metrics"));
        assert!(!admin.api_path_allowed("/v1/ns/operator/metrics"));
    }

    #[tokio::test]
    async fn service_upsert_normalizes_empty_selector() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("POST /nacos/v1/ns/service HTTP/1.1"));
            assert!(request.contains("selector="));
            assert!(request.contains("%22type%22%3A%22none%22"));
            write_json_response(&mut socket, r#"{"code":200,"message":"ok"}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_service(NacosServiceUpsert {
                namespace: Some("public".to_string()),
                service_name: "dbx-e2e".to_string(),
                group_name: Some("DEFAULT_GROUP".to_string()),
                metadata: Some(serde_json::json!({})),
                protect_threshold: Some(0.3),
                selector: Some(serde_json::json!({})),
                ephemeral: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_instance_update_uses_v1_naming_api() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("PUT /nacos/v1/ns/instance HTTP/1.1"));
            assert!(request.contains("weight=2.5"));
            assert!(request.contains("ephemeral=false"));
            write_json_response(&mut socket, r#"{"code":200,"message":"ok"}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .update_instance(NacosInstanceUpdateRequest {
                target: NacosInstanceRef {
                    namespace: Some("public".to_string()),
                    service_name: "dbx-e2e".to_string(),
                    ip: "127.0.0.1".to_string(),
                    port: 19001,
                    group_name: Some("DBX_E2E".to_string()),
                    cluster_name: Some("blue".to_string()),
                    ephemeral: Some(false),
                },
                patch: NacosInstancePatch { weight: Some(2.5), ..Default::default() },
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_instance_update_uses_partial_patch_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("PUT /nacos/v3/admin/ns/instance/partial HTTP/1.1"));
            assert!(request.contains("serviceName=dbx-e2e"));
            assert!(request.contains("groupName=DBX_E2E"));
            assert!(request.contains("clusterName=blue"));
            assert!(request.contains("ip=127.0.0.1"));
            assert!(request.contains("port=19001"));
            assert!(request.contains("enabled=false"));
            assert!(request.contains("ephemeral=false"));
            assert!(!request.contains("healthy="));
            assert!(!request.contains("weight="));
            assert!(!request.contains("metadata="));
            write_json_response(&mut socket, r#"{"code":0,"message":"success","data":"ok"}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let health_error = admin
            .update_instance(NacosInstanceUpdateRequest {
                target: NacosInstanceRef {
                    namespace: Some("public".to_string()),
                    service_name: "dbx-e2e".to_string(),
                    ip: "127.0.0.1".to_string(),
                    port: 19001,
                    group_name: Some("DBX_E2E".to_string()),
                    cluster_name: Some("blue".to_string()),
                    ephemeral: Some(false),
                },
                patch: NacosInstancePatch { healthy: Some(false), ..Default::default() },
            })
            .await
            .unwrap_err();
        assert!(health_error.contains("NACOS_ERROR[unsupportedOperation]"));
        assert!(health_error.contains("Official Nacos 3"));

        admin
            .update_instance(NacosInstanceUpdateRequest {
                target: NacosInstanceRef {
                    namespace: Some("public".to_string()),
                    service_name: "dbx-e2e".to_string(),
                    ip: "127.0.0.1".to_string(),
                    port: 19001,
                    group_name: Some("DBX_E2E".to_string()),
                    cluster_name: Some("blue".to_string()),
                    ephemeral: Some(false),
                },
                patch: NacosInstancePatch { enabled: Some(false), ..Default::default() },
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_service_and_instance_lists_use_documented_naming_admin_routes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut service_socket, _) = listener.accept().await.unwrap();
            let service_target = read_request_target(&mut service_socket).await;
            let service_url = reqwest::Url::parse(&format!("http://localhost{service_target}")).unwrap();
            assert_eq!(service_url.path(), "/nacos/v3/admin/ns/service/list");
            let service_params = service_url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(service_params.get("groupNameParam").map(|value| value.as_ref()), Some("DBX_E2E"));
            write_json_response(
                &mut service_socket,
                r#"{"code":0,"message":"success","data":{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"name":"dbx-e2e","groupName":"DBX_E2E","clusterCount":1,"ipCount":2,"healthyInstanceCount":1,"triggerFlag":"false"}]}}"#,
            )
            .await;

            let (mut detail_socket, _) = listener.accept().await.unwrap();
            let detail_target = read_request_target(&mut detail_socket).await;
            let detail_url = reqwest::Url::parse(&format!("http://localhost{detail_target}")).unwrap();
            assert_eq!(detail_url.path(), "/nacos/v3/admin/ns/service");
            write_json_response(
                &mut detail_socket,
                r#"{"code":0,"message":"success","data":{"clusterMap":{"blue":{"clusterName":"blue"},"green":{"clusterName":"green"}}}}"#,
            )
            .await;

            let (mut instance_socket, _) = listener.accept().await.unwrap();
            let instance_target = read_request_target(&mut instance_socket).await;
            let instance_url = reqwest::Url::parse(&format!("http://localhost{instance_target}")).unwrap();
            assert_eq!(instance_url.path(), "/nacos/v3/admin/ns/instance/list");
            let instance_params = instance_url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(instance_params.get("serviceName").map(|value| value.as_ref()), Some("dbx-e2e"));
            assert_eq!(instance_params.get("clusterName").map(|value| value.as_ref()), Some("blue"));
            write_json_response(
                &mut instance_socket,
                r#"{"code":0,"message":"success","data":[{"ip":"127.0.0.1","port":19001,"clusterName":"blue","ephemeral":false,"enabled":true,"healthy":true,"weight":1.0}]}"#,
            )
            .await;

            let (mut green_socket, _) = listener.accept().await.unwrap();
            let green_target = read_request_target(&mut green_socket).await;
            let green_url = reqwest::Url::parse(&format!("http://localhost{green_target}")).unwrap();
            assert_eq!(green_url.path(), "/nacos/v3/admin/ns/instance/list");
            let green_params = green_url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(green_params.get("clusterName").map(|value| value.as_ref()), Some("green"));
            write_json_response(
                &mut green_socket,
                r#"{"code":0,"message":"success","data":[{"ip":"127.0.0.1","port":19002,"clusterName":"green","ephemeral":false,"enabled":false,"healthy":false,"weight":0.5}]}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let services = admin
            .list_services(NacosServiceQuery {
                namespace: Some("public".to_string()),
                group_name: Some("DBX_E2E".to_string()),
                service_name: None,
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();
        assert_eq!(services.items.len(), 1);

        let instances = admin
            .list_instances(NacosInstanceQuery {
                namespace: Some("public".to_string()),
                service_name: "dbx-e2e".to_string(),
                group_name: Some("DBX_E2E".to_string()),
                clusters: None,
            })
            .await
            .unwrap();
        assert_eq!(instances.len(), 2);
        assert_eq!(instances[1].enabled, Some(false));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_empty_service_instance_list_returns_empty_without_inventing_a_default_cluster() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            assert_eq!(url.path(), "/nacos/v3/admin/ns/service");
            write_json_response(&mut socket, r#"{"code":0,"message":"success","data":{"clusterMap":{}}}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let instances = admin
            .list_instances(NacosInstanceQuery {
                namespace: Some("public".to_string()),
                service_name: "custom-cluster-service".to_string(),
                group_name: Some("DBX_V3".to_string()),
                clusters: None,
            })
            .await
            .unwrap();
        assert!(instances.is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_service_list_uses_catalog_to_enumerate_groups() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), "/nacos/v1/ns/catalog/services");
            assert_eq!(params.get("groupNameParam").map(|value| value.as_ref()), Some("DBX_CURL"));
            write_json_response(
                &mut socket,
                r#"{"count":1,"serviceList":[{"name":"dbx-curl-e2e","groupName":"DBX_CURL","clusterCount":1,"ipCount":1}]}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let result = admin
            .list_services(NacosServiceQuery {
                namespace: Some("public".to_string()),
                service_name: None,
                group_name: Some("DBX_CURL".to_string()),
                page_no: Some(1),
                page_size: Some(100),
            })
            .await
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].service_name, "dbx-curl-e2e");
        assert_eq!(result.items[0].group_name.as_deref(), Some("DBX_CURL"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_service_list_uses_catalog_without_a_v3_admin_probe() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), "/nacos/v1/ns/catalog/services");
            assert_eq!(params.get("groupNameParam").map(|value| value.as_ref()), Some("DBX_RNACOS"));
            write_json_response(
                &mut socket,
                r#"{"count":1,"serviceList":[{"name":"dbx-demo-api","groupName":"DBX_RNACOS"}]}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let result = admin
            .list_services(NacosServiceQuery {
                namespace: Some("public".to_string()),
                service_name: None,
                group_name: Some("DBX_RNACOS".to_string()),
                page_no: Some(1),
                page_size: Some(100),
            })
            .await
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].service_name, "dbx-demo-api");
        assert_eq!(result.items[0].group_name.as_deref(), Some("DBX_RNACOS"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_instance_list_uses_v1_naming_without_catalog_or_v3_probes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            assert_eq!(url.path(), "/nacos/v1/ns/instance/list");
            write_json_response(
                &mut socket,
                r#"{"hosts":[{"ip":"127.0.0.1","port":19201,"clusterName":"blue","healthy":true,"enabled":true,"ephemeral":false}]}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let instances = admin
            .list_instances(NacosInstanceQuery {
                namespace: Some("public".to_string()),
                service_name: "dbx-demo-api".to_string(),
                group_name: Some("DBX_RNACOS".to_string()),
                clusters: None,
            })
            .await
            .unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].port, 19201);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_console_instance_list_includes_disabled_instances() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let target = request.split_whitespace().nth(1).unwrap();
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), "/rnacos/api/console/v2/instance/list");
            assert_eq!(params.get("namespaceId").map(|value| value.as_ref()), Some("public"));
            assert_eq!(params.get("groupName").map(|value| value.as_ref()), Some("DBX_RNACOS"));
            assert_eq!(params.get("serviceName").map(|value| value.as_ref()), Some("dbx-demo-api"));
            assert!(request.to_ascii_lowercase().contains("\ntoken: console-token\r"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"totalCount":3,"list":[{"ip":"127.0.0.1","port":19201,"clusterName":"blue","healthy":true,"enabled":true,"ephemeral":false},{"ip":"127.0.0.1","port":19202,"clusterName":"green","healthy":true,"enabled":true,"ephemeral":false},{"ip":"127.0.0.1","port":19203,"clusterName":"green-shadow","healthy":true,"enabled":false,"ephemeral":false}]}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let instances = admin
            .list_instances(NacosInstanceQuery {
                namespace: Some("public".to_string()),
                service_name: "dbx-demo-api".to_string(),
                group_name: Some("DBX_RNACOS".to_string()),
                clusters: None,
            })
            .await
            .unwrap();
        assert_eq!(instances.len(), 3);
        assert!(instances.iter().any(|instance| instance.port == 19203 && instance.enabled == Some(false)));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_service_and_instance_crud_use_only_compatible_v1_routes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for (method, path) in [
                ("POST", "/nacos/v1/ns/service"),
                ("PUT", "/nacos/v1/ns/service"),
                ("DELETE", "/nacos/v1/ns/service?"),
                ("PUT", "/nacos/v1/ns/instance"),
                ("POST", "/nacos/v1/ns/instance"),
                ("DELETE", "/nacos/v1/ns/instance?"),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let request_line = request.lines().next().unwrap();
                assert!(request_line.starts_with(&format!("{method} {path}")), "unexpected request: {request_line}");
                assert!(!request_line.contains("/v3/"));
                write_text_response(&mut socket, "ok").await;
            }
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        let service = NacosServiceUpsert {
            namespace: Some("public".to_string()),
            service_name: "dbx-rnacos-crud".to_string(),
            group_name: Some("DBX_RNACOS".to_string()),
            metadata: Some(serde_json::json!({ "managed-by": "dbx" })),
            protect_threshold: Some(0.2),
            selector: None,
            ephemeral: None,
        };
        admin.create_service(service.clone()).await.unwrap();
        admin.update_service(service.clone()).await.unwrap();
        admin
            .delete_service(NacosServiceQuery {
                namespace: Some("public".to_string()),
                service_name: Some(service.service_name.clone()),
                group_name: service.group_name.clone(),
                page_no: None,
                page_size: None,
            })
            .await
            .unwrap();

        let target = NacosInstanceRef {
            namespace: Some("public".to_string()),
            service_name: service.service_name.clone(),
            group_name: service.group_name.clone(),
            ip: "127.0.0.1".to_string(),
            port: 19299,
            cluster_name: Some("manual".to_string()),
            ephemeral: Some(false),
        };
        admin
            .update_instance(NacosInstanceUpdateRequest {
                target: target.clone(),
                patch: NacosInstancePatch { enabled: Some(false), ..Default::default() },
            })
            .await
            .unwrap();
        admin
            .register_instance(NacosInstanceRegistration {
                namespace: target.namespace.clone(),
                service_name: target.service_name.clone(),
                group_name: target.group_name.clone(),
                ip: target.ip.clone(),
                port: target.port,
                cluster_name: target.cluster_name.clone(),
                weight: Some(1.0),
                metadata: Some(serde_json::json!({ "managed-by": "dbx" })),
            })
            .await
            .unwrap();
        admin.deregister_instance(target).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_service_detail_embeds_the_group_in_the_service_name() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), "/nacos/v1/ns/service");
            assert_eq!(params.get("serviceName").map(|value| value.as_ref()), Some("DBX_RNACOS@@dbx-demo-api"));
            assert!(!params.contains_key("groupName"));
            write_json_response(
                &mut socket,
                r#"{"namespaceId":"public","groupName":"DBX_RNACOS","name":"dbx-demo-api","metadata":{},"selector":{"type":"none","contextType":"NONE"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_service(NacosServiceQuery {
                namespace: Some("public".to_string()),
                service_name: Some("dbx-demo-api".to_string()),
                group_name: Some("DBX_RNACOS".to_string()),
                page_no: None,
                page_size: None,
            })
            .await
            .unwrap();
        assert_eq!(detail.service_name, "dbx-demo-api");
        assert_eq!(detail.group_name.as_deref(), Some("DBX_RNACOS"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_service_list_uses_group_api_for_empty_service() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            assert_eq!(url.path(), "/nacos/v1/ns/catalog/services");
            write_json_response(&mut socket, r#"{"count":0,"serviceList":[]}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(url.path(), "/nacos/v2/ns/service/list");
            assert_eq!(params.get("groupName").map(|value| value.as_ref()), Some("DBX_CURL"));
            assert!(!params.contains_key("groupNameParam"));
            write_json_response(
                &mut socket,
                r#"{"code":0,"message":"success","data":{"count":1,"services":["dbx-empty-e2e"]}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let result = admin
            .list_services(NacosServiceQuery {
                namespace: Some("public".to_string()),
                service_name: None,
                group_name: Some("DBX_CURL".to_string()),
                page_no: Some(1),
                page_size: Some(100),
            })
            .await
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].service_name, "dbx-empty-e2e");
        assert_eq!(result.items[0].group_name.as_deref(), Some("DBX_CURL"));
        server.await.unwrap();
    }

    #[test]
    fn compacts_html_error_pages_in_admin_warnings() {
        assert_eq!(
            compact_response_detail("<!doctype html><html><body><h1>HTTP Status 404</h1></body></html>"),
            "HTML error page"
        );
        assert!(compact_response_detail(&"x".repeat(600)).ends_with('…'));
    }

    #[test]
    fn gives_nacos_v3_dashboard_endpoint_guidance() {
        let mut config = test_admin_config("http://127.0.0.1:8080".to_string());
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config.clone()).unwrap();

        let warning =
            admin.dashboard_warning("NACOS_ERROR[contextPathMismatch]: No static resource v3/admin".to_string());
        assert!(warning.contains("Server / Admin API endpoint"));
        assert!(warning.contains("http://host:8848/nacos"));

        config.api_plane = Some(NacosApiPlane::Console);
        let console = NacosOpenApiAdmin::new(config).unwrap();
        let warning =
            console.dashboard_warning("NACOS_ERROR[contextPathMismatch]: No static resource v3/console".to_string());
        assert!(warning.contains("Console API endpoint"));
        assert!(warning.contains("http://host:8080"));
    }

    #[test]
    fn prometheus_metrics_preserve_namespace_dashboard_values() {
        let mut metrics = Some(NacosDashboardMetrics {
            service_count: Some(1),
            instance_count: Some(2),
            cpu: Some(0.1),
            ..Default::default()
        });
        let config_count = Some(3);
        let service_count = Some(1);
        let prometheus = NacosPrometheusSnapshot {
            resource: NacosPrometheusResourceMetrics { cpu_ratio: Some(0.5), ..Default::default() },
            config: NacosPrometheusConfigMetrics { config_count: Some(7.0), ..Default::default() },
            naming: NacosPrometheusNamingMetrics {
                service_count: Some(8.0),
                instance_count: Some(9.0),
                ..Default::default()
            },
            ..Default::default()
        };

        merge_prometheus_dashboard(&mut metrics, Some(&prometheus));

        let metrics = metrics.unwrap();
        assert_eq!(config_count, Some(3));
        assert_eq!(service_count, Some(1));
        assert_eq!(metrics.service_count, Some(1));
        assert_eq!(metrics.instance_count, Some(9));
        assert_eq!(metrics.cpu, Some(0.5));
    }

    #[tokio::test]
    async fn nacos_v2_dashboard_uses_core_cluster_node_api() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v2/core/cluster/node/list");
            write_json_response(&mut socket, r#"{"code":0,"data":[{"address":"127.0.0.1:8848","state":"UP"}]}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let nodes = admin.get_dashboard_nodes().await.unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].address, "127.0.0.1:8848");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn nacos_v2_dashboard_falls_back_to_legacy_core_cluster_nodes_api() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v2/core/cluster/node/list");
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/core/cluster/nodes");
            write_json_response(&mut socket, r#"{"code":200,"data":[{"address":"127.0.0.1:8848","state":"UP"}]}"#)
                .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let nodes = admin.get_dashboard_nodes().await.unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].address, "127.0.0.1:8848");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_dashboard_skips_unsupported_cluster_node_api() {
        let mut config = test_admin_config("http://127.0.0.1:1".to_string());
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert!(admin.get_dashboard_nodes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn version_mode_v3_uses_only_v3_config_paths() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v3/admin/cs/config/list?"));
            write_json_response(&mut socket, r#"{"totalCount":0,"pageItems":[]}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin.get_config_list_value("", "", "", "", 1, 20).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_admin_namespace_creation_uses_namespace_id() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().next(), Some("POST"));
            assert_eq!(request.split_whitespace().nth(1), Some("/nacos/v3/admin/core/namespace"));
            assert!(request.contains("namespaceId=team-dev"));
            assert!(!request.contains("customNamespaceId="));
            write_json_response(&mut socket, r#"{"code":0,"message":"success","data":true}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_namespace(NacosNamespaceCreate {
                namespace_id: Some("team-dev".to_string()),
                namespace_name: "Team Development".to_string(),
                namespace_desc: Some("Development environment".to_string()),
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_console_namespace_creation_uses_custom_namespace_id() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().next(), Some("POST"));
            assert_eq!(request.split_whitespace().nth(1), Some("/nacos/v3/console/core/namespace"));
            assert_eq!(request_form_value(&request, "customNamespaceId"), Some("team-console"));
            assert!(request_form_value(&request, "namespaceId").is_none());
            write_json_response(&mut socket, r#"{"code":0,"message":"success","data":true}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        config.api_plane = Some(NacosApiPlane::Console);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_namespace(NacosNamespaceCreate {
                namespace_id: Some("team-console".to_string()),
                namespace_name: "Team Console".to_string(),
                namespace_desc: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_admin_namespace_creation_generates_namespace_id_when_empty() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().nth(1), Some("/nacos/v3/admin/core/namespace"));
            let namespace_id = request_form_value(&request, "namespaceId").expect("namespaceId should be present");
            uuid::Uuid::parse_str(namespace_id).expect("namespaceId should be a UUID");
            assert!(request_form_value(&request, "customNamespaceId").is_none());
            write_json_response(&mut socket, r#"{"code":0,"message":"success","data":true}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_namespace(NacosNamespaceCreate {
                namespace_id: Some("   ".to_string()),
                namespace_name: "Generated V3 ID".to_string(),
                namespace_desc: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_connection_check_uses_only_admin_core_and_naming_endpoints() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut state_socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut state_socket).await, "/nacos/v3/admin/core/state");
            write_json_response(&mut state_socket, r#"{"version":"3.1.0","auth_enabled":"false"}"#).await;

            let (mut namespaces_socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut namespaces_socket).await, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut namespaces_socket,
                r#"{"code":0,"message":"success","data":[{"namespace":"public","namespaceShowName":"public"}]}"#,
            )
            .await;

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert_eq!(info.server_version.as_deref(), Some("3.1.0"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_console_connection_uses_console_routes_and_access_token_header() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("GET /v3/console/server/state HTTP/1.1"));
            assert!(!request.to_ascii_lowercase().contains("accesstoken:"));
            write_json_response(&mut socket, r#"{"version":"3.2.1","auth_enabled":"true"}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("POST /v3/auth/user/login HTTP/1.1"));
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"console-token","tokenTtl":18000}}"#)
                .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let target = request.split_whitespace().nth(1).unwrap();
            assert!(target.starts_with("/v3/console/core/namespace/list"), "unexpected request target: {target}");
            assert!(!target.contains("accessToken="));
            assert!(request.to_ascii_lowercase().contains("accesstoken: console-token"));
            write_json_response(
                &mut socket,
                r#"{"code":0,"data":[{"namespace":"public","namespaceShowName":"public"}]}"#,
            )
            .await;

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.api_plane = Some(NacosApiPlane::Console);
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "nacos".to_string(), password: "secret".to_string() };

        let info = NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap();

        assert_eq!(info.server_version.as_deref(), Some("3.2.1"));
        assert!(!info.capabilities.supports_raw_api);
        assert!(!info.capabilities.service_management.update_instance_health.supported);
        assert!(!info.capabilities.service_management.register_instance.supported);
        assert!(!info.capabilities.service_management.deregister_instance.supported);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_regular_connection_does_not_probe_access_control() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/ns/operator/servers");
            write_json_response(&mut socket, "{}").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"ordinary-token","tokenTtl":18000}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/console/namespaces?"));
            write_json_response(&mut socket, r#"[{"namespace":"public","namespaceShowName":"public"}]"#).await;

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };

        let info = NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap();

        assert!(!info.capabilities.access_control.enhanced_workspace);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_regular_connection_without_scope_defers_workspace_validation_to_namespace_selection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/state");
            write_json_response(&mut socket, r#"{"version":"3.1.0"}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/auth/user/login");
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000}}"#)
                .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut socket,
                r#"{"code":0,"message":"success","data":[{"namespace":"public","namespaceShowName":"public"}]}"#,
            )
            .await;

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };

        let info = NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap();

        assert!(!info.capabilities.access_control.enhanced_workspace);
        assert_eq!(info.capabilities.access_control.list_permissions.reason, Some(NacosCapabilityReason::NotVerified));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_connection_check_with_explicit_scope_skips_permission_probe() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/ns/operator/servers");
            write_json_response(&mut socket, "{}").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"ordinary-token","tokenTtl":18000}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/console/namespaces?"));
            write_json_response(&mut socket, r#"[{"namespace":"public","namespaceShowName":"public"}]"#).await;

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string()];

        let info = NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap();

        assert!(!info.capabilities.access_control.enhanced_workspace);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_explicit_connection_test_validates_every_managed_namespace() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/ns/operator/servers");
            write_json_response(&mut socket, "{}").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"ordinary-token","tokenTtl":18000}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/console/namespaces?"));
            write_forbidden_response(&mut socket).await;

            for namespace in ["team-a", "team-b"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let target = read_request_target(&mut socket).await;
                assert!(target.starts_with("/nacos/v1/cs/configs?"));
                assert!(target.contains(&format!("tenant={namespace}")));
                write_json_response(&mut socket, r#"{"totalCount":0,"pageItems":[]}"#).await;

                let (mut socket, _) = listener.accept().await.unwrap();
                let target = read_request_target(&mut socket).await;
                assert!(target.starts_with("/nacos/v1/ns/catalog/services?"));
                assert!(target.contains(&format!("namespaceId={namespace}")));
                write_json_response(&mut socket, r#"{"count":0,"serviceList":[]}"#).await;
            }
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string(), "team-b".to_string()];

        NacosOpenApiAdmin::new(config).unwrap().test_connection_with_scope_validation().await.unwrap();

        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_explicit_connection_test_rejects_an_unreadable_managed_namespace() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/ns/operator/servers");
            write_json_response(&mut socket, "{}").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"ordinary-token","tokenTtl":18000}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/console/namespaces?"));
            write_forbidden_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/cs/configs?"));
            write_forbidden_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/ns/catalog/services?"));
            write_json_response(&mut socket, r#"{"count":0,"serviceList":[]}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string()];

        let error = NacosOpenApiAdmin::new(config).unwrap().test_connection_with_scope_validation().await.unwrap_err();

        assert!(error.contains("NACOS_ERROR[managedNamespaceAccessDenied]"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_regular_connection_with_explicit_scope_validates_one_representative_namespace() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/state");
            write_json_response(&mut socket, r#"{"version":"3.1.0"}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/auth/user/login");
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000}}"#)
                .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut socket,
                r#"{"code":10001,"message":"access denied","data":"Code: 403, Message: authorization failed!."}"#,
            )
            .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/nacos/v3/admin/ns/service/list?"));
            assert!(target.contains("namespaceId=team-a"));
            write_json_response(
                &mut socket,
                r#"{"code":0,"message":"success","data":{"totalCount":0,"pageItems":[]}}"#,
            )
            .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/nacos/v3/admin/cs/config/list?"));
            assert!(target.contains("namespaceId=team-a"));
            write_json_response(
                &mut socket,
                r#"{"code":0,"message":"success","data":{"totalCount":0,"pageItems":[]}}"#,
            )
            .await;

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string()];

        let info = NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap();

        assert!(!info.capabilities.access_control.enhanced_workspace);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_explicit_connection_test_validates_every_managed_namespace() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/state");
            write_json_response(&mut socket, r#"{"version":"3.1.0"}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/auth/user/login");
            write_json_response(&mut socket, r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000}}"#)
                .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/admin/core/namespace/list");
            write_json_response(
                &mut socket,
                r#"{"code":10001,"message":"access denied","data":"Code: 403, Message: authorization failed!."}"#,
            )
            .await;

            for namespace in ["team-a", "team-b"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let target = read_request_target(&mut socket).await;
                assert!(target.starts_with("/nacos/v3/admin/ns/service/list?"));
                assert!(target.contains(&format!("namespaceId={namespace}")));
                write_json_response(
                    &mut socket,
                    r#"{"code":0,"message":"success","data":{"totalCount":0,"pageItems":[]}}"#,
                )
                .await;

                let (mut socket, _) = listener.accept().await.unwrap();
                let target = read_request_target(&mut socket).await;
                assert!(target.starts_with("/nacos/v3/admin/cs/config/list?"));
                assert!(target.contains(&format!("namespaceId={namespace}")));
                write_json_response(
                    &mut socket,
                    r#"{"code":0,"message":"success","data":{"totalCount":0,"pageItems":[]}}"#,
                )
                .await;
            }

            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        config.managed_namespaces = vec!["team-a".to_string(), "team-b".to_string()];

        NacosOpenApiAdmin::new(config).unwrap().test_connection_with_scope_validation().await.unwrap();

        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_access_control_reads_are_probed_per_resource() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            assert_eq!(accept_json_request(&listener, r#"{"version":"3.1.0"}"#).await, "/nacos/v3/admin/core/state");
            assert_eq!(
                accept_json_request(
                    &listener,
                    r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000,"globalAdmin":false}}"#,
                )
                .await,
                "/nacos/v3/auth/user/login"
            );
            assert!(
                accept_json_request(
                    &listener,
                    r#"{"code":0,"data":[{"namespace":"public","namespaceShowName":"public"}]}"#,
                )
                .await
                    == "/nacos/v3/admin/core/namespace/list"
            );
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v3/auth/user/list?"));
            write_forbidden_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v3/auth/role/list?"));
            write_forbidden_response(&mut socket).await;

            assert!(accept_json_request(&listener, r#"{"code":0,"data":{"totalCount":0,"pageItems":[]}}"#,)
                .await
                .starts_with("/nacos/v3/auth/permission/list?"));
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };

        let info = NacosOpenApiAdmin::new(config).unwrap().inspect_connection().await.unwrap();
        let capabilities = info.capabilities.access_control;

        assert!(!capabilities.list_users.supported);
        assert_eq!(capabilities.list_users.reason, Some(NacosCapabilityReason::PermissionDenied));
        assert!(!capabilities.list_role_bindings.supported);
        assert_eq!(capabilities.list_role_bindings.reason, Some(NacosCapabilityReason::PermissionDenied));
        assert!(capabilities.list_permissions.supported);
        assert!(!capabilities.create_user.supported);
        assert!(!capabilities.assign_role.supported);
        assert!(!capabilities.grant_permission.supported);
        assert!(!capabilities.enhanced_workspace);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_namespace_authorization_reuses_capability_probe_rows() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            assert_eq!(
                accept_json_request(
                    &listener,
                    r#"{"code":0,"data":{"accessToken":"ordinary-token","tokenTtl":18000,"globalAdmin":false}}"#,
                )
                .await,
                "/nacos/v3/auth/user/login"
            );
            assert!(
                accept_json_request(
                    &listener,
                    r#"{"code":0,"data":[{"namespace":"team-a","namespaceShowName":"Team A"}]}"#,
                )
                .await
                    == "/nacos/v3/admin/core/namespace/list"
            );
            assert!(accept_json_request(
                &listener,
                r#"{"code":0,"data":{"totalCount":1,"pageItems":[{"username":"ordinary"}]}}"#,
            )
            .await
            .starts_with("/nacos/v3/auth/user/list?"));
            assert!(accept_json_request(
                &listener,
                r#"{"code":0,"data":{"totalCount":1,"pageItems":[{"username":"ordinary","role":"reader"}]}}"#,
            )
            .await
            .starts_with("/nacos/v3/auth/role/list?"));
            assert!(accept_json_request(
                &listener,
                r#"{"code":0,"data":{"totalCount":1,"pageItems":[{"role":"reader","resource":"team-a:*:*","action":"r"}]}}"#,
            )
            .await
            .starts_with("/nacos/v3/auth/permission/list?"));
            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin.list_namespaces().await.unwrap();
        let authorization = admin.refresh_namespace_authorization("ordinary").await.unwrap().unwrap();

        assert_eq!(authorization.roles, vec!["reader"]);
        assert_eq!(authorization.permissions.len(), 1);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v3_read_only_admin_has_read_capabilities_but_no_write_capabilities() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            assert_eq!(accept_json_request(&listener, r#"{"version":"3.1.0"}"#).await, "/nacos/v3/admin/core/state");
            assert_eq!(
                accept_json_request(
                    &listener,
                    r#"{"code":0,"data":{"accessToken":"readonly-token","tokenTtl":18000,"globalAdmin":false}}"#,
                )
                .await,
                "/nacos/v3/auth/user/login"
            );
            assert!(
                accept_json_request(
                    &listener,
                    r#"{"code":0,"data":[{"namespace":"public","namespaceShowName":"public"}]}"#,
                )
                .await
                    == "/nacos/v3/admin/core/namespace/list"
            );
            assert!(accept_json_request(
                &listener,
                r#"{"code":0,"data":{"totalCount":1,"pageItems":[{"username":"readonly"}]}}"#,
            )
            .await
            .starts_with("/nacos/v3/auth/user/list?"));
            assert!(accept_json_request(
                &listener,
                r#"{"code":0,"data":{"totalCount":1,"pageItems":[{"username":"readonly","role":"READ_ONLY"}]}}"#,
            )
            .await
            .starts_with("/nacos/v3/auth/role/list?"));
            assert!(accept_json_request(
                &listener,
                r#"{"code":0,"data":{"totalCount":3,"pageItems":[{"role":"READ_ONLY","resource":"console/users","action":"r"},{"role":"READ_ONLY","resource":"console/roles","action":"r"},{"role":"READ_ONLY","resource":"console/permissions","action":"r"}]}}"#,
            )
            .await
            .starts_with("/nacos/v3/auth/permission/list?"));
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "readonly".to_string(), password: "secret".to_string() };

        let info = NacosOpenApiAdmin::new(config).unwrap().inspect_connection().await.unwrap();
        let capabilities = info.capabilities.access_control;

        assert!(capabilities.list_users.supported);
        assert!(capabilities.list_role_bindings.supported);
        assert!(capabilities.list_permissions.supported);
        for operation in [
            NacosAccessControlOperation::CreateUser,
            NacosAccessControlOperation::UpdateUser,
            NacosAccessControlOperation::DeleteUser,
            NacosAccessControlOperation::AssignRole,
            NacosAccessControlOperation::RemoveRole,
            NacosAccessControlOperation::GrantPermission,
            NacosAccessControlOperation::RevokePermission,
        ] {
            let capability = capabilities.operation(operation);
            assert!(!capability.supported);
            assert_eq!(capability.reason, Some(NacosCapabilityReason::PermissionDenied));
        }
        assert!(capabilities.enhanced_workspace);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_namespace_creation_uses_legacy_custom_namespace_id() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().next(), Some("POST"));
            assert_eq!(request.split_whitespace().nth(1), Some("/nacos/v1/console/namespaces"));
            assert!(request.contains("customNamespaceId=team-v2"));
            write_json_response(&mut socket, "true").await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_namespace(NacosNamespaceCreate {
                namespace_id: Some("team-v2".to_string()),
                namespace_name: "Team V2".to_string(),
                namespace_desc: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_namespace_creation_generates_matching_namespace_ids_when_empty() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().nth(1), Some("/nacos/v1/console/namespaces"));
            let custom_namespace_id =
                request_form_value(&request, "customNamespaceId").expect("customNamespaceId should be present");
            let namespace_id = request_form_value(&request, "namespaceId").expect("namespaceId should be present");
            assert_eq!(custom_namespace_id, namespace_id);
            uuid::Uuid::parse_str(namespace_id).expect("generated namespace ID should be a UUID");
            write_json_response(&mut socket, "true").await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_namespace(NacosNamespaceCreate {
                namespace_id: None,
                namespace_name: "Generated V2 ID".to_string(),
                namespace_desc: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_namespace_creation_falls_back_to_nacos_compatible_v1_route() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().nth(1), Some("/v1/console/namespaces"));
            assert!(request.contains("customNamespaceId=team-rnacos"));
            write_json_response(&mut socket, "true").await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .create_namespace(NacosNamespaceCreate {
                namespace_id: Some("team-rnacos".to_string()),
                namespace_name: "Team r-nacos".to_string(),
                namespace_desc: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn legacy_auto_mode_uses_v1_config_paths_without_cross_version_fallback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v1/cs/configs?"));
            write_json_response(&mut socket, r#"{"totalCount":0,"pageItems":[]}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::Auto);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin.get_config_list_value("", "", "", "", 1, 20).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_rnacos_reports_unavailable_openapi_namespace_directory() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/v1/console/namespaces");
            write_not_found_response(&mut socket).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.rnacos_console_auth = crate::nacos::config::NacosRNacosConsoleAuth::UsernamePassword {
            username: "admin".to_string(),
            password: "admin".to_string(),
        };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let error = admin.list_namespaces().await.unwrap_err();
        assert!(error.contains("NACOS_ERROR[rnacosNamespaceDirectoryUnavailable]"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_connection_accepts_a_missing_namespace_directory() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_json_response(&mut socket, "success").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_not_found_response(&mut socket).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.context_path = "/nacos".to_string();

        NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_connection_rejects_namespace_directory_authorization_failures() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_json_response(&mut socket, "success").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"rnacos-token","tokenTtl":18000}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/nacos/v1/console/namespaces?"));
            assert!(target.contains("accessToken=rnacos-token"));
            write_forbidden_response(&mut socket).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "ordinary".to_string(), password: "secret".to_string() };

        let error = NacosOpenApiAdmin::new(config).unwrap().test_connection().await.unwrap_err();

        assert!(error.contains("/v1/console/namespaces returned 403 Forbidden"));
        assert!(!error.contains("NACOS_ERROR[rnacosNamespaceDirectoryUnavailable]"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_get_config_uses_console_for_content_and_type() {
        // r-nacos console is the source of truth for content + configType.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = "{\n  \"Name\": \"Hello\"\n}";
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(request.contains("dataId=hello.json"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"{\n  \"Name\": \"Hello\"\n}","configType":"JSON","desc":"from-console","md5":"abc"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("public".to_string()),
                data_id: "hello.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some(body));
        assert_eq!(detail.config_type.as_deref(), Some("json"));
        assert_eq!(detail.desc.as_deref(), Some("from-console"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_get_config_falls_back_to_openapi_without_console() {
        // Without a console URL, OpenAPI body text is the only available content.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = "{\n  \"Name\": \"Hello\"\n}";
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/v1/cs/configs?"));
            assert!(!target.contains("show=all"));
            write_json_response(&mut socket, "{\n  \"Name\": \"Hello\"\n}").await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("public".to_string()),
                data_id: "hello.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some(body));
        assert_eq!(detail.config_type, None);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_get_config_falls_back_to_openapi_when_console_is_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = "{\n  \"Name\": \"Hello\"\n}";
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            write_json_response(&mut socket, r#"{"success":false,"message":"console unavailable"}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/v1/cs/configs?"));
            assert!(!target.contains("show=all"));
            write_json_response(&mut socket, body).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("public".to_string()),
                data_id: "hello.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some(body));
        assert_eq!(detail.config_type, None);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_get_config_preserves_invalid_json_via_console_value() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = "{\n  \"Name\": \"Hello\",\n}";
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"{\n  \"Name\": \"Hello\",\n}","configType":"JSON"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("public".to_string()),
                data_id: "hello.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some(body));
        assert_eq!(detail.config_type.as_deref(), Some("json"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn official_nacos_uses_show_all_detail_document() {
        // Official Nacos implements show=all as a JSON detail document.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/v1/cs/configs?"));
            assert!(target.contains("show=all"));
            write_json_response(
                &mut socket,
                r#"{"dataId":"app.json","group":"DEFAULT_GROUP","tenant":"ops","type":"json","content":"{\"Name\":\"Hello\"}"}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("ops".to_string()),
                data_id: "app.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.data_id, "app.json");
        assert_eq!(detail.namespace, "ops");
        assert_eq!(detail.config_type.as_deref(), Some("json"));
        assert_eq!(detail.content.as_deref(), Some(r#"{"Name":"Hello"}"#));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn detected_rnacos_uses_console_when_configured() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"Name":"Hello"}"#;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"{\"Name\":\"Hello\"}","configType":"JSON"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.detected_rnacos.store(true, Ordering::Relaxed);

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("public".to_string()),
                data_id: "hello.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some(body));
        assert_eq!(detail.config_type.as_deref(), Some("json"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_console_detail_keeps_json_with_data_id_field_as_text() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"dataId":"nested-key","enabled":true}"#;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"{\"dataId\":\"nested-key\",\"enabled\":true}","configType":"JSON"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("public".to_string()),
                data_id: "settings.json".to_string(),
                group: "DEFAULT_GROUP".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some(body));
        assert_eq!(detail.data_id, "settings.json");
        assert_eq!(detail.config_type.as_deref(), Some("json"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_detail_loads_from_console_with_session_token() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(request.contains("tenant=ops"));
            assert!(request.contains("dataId=qilong-test"));
            assert!(request.contains("group=qilong-test"));
            assert!(request.to_ascii_lowercase().contains("token: console-token"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"cloud_providers: {}\n","md5":"abc123","configType":"YAML","desc":"r-nacos description"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.rnacos_console_auth = crate::nacos::config::NacosRNacosConsoleAuth::UsernamePassword {
            username: "admin".to_string(),
            password: "admin".to_string(),
        };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("ops".to_string()),
                data_id: "qilong-test".to_string(),
                group: "qilong-test".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some("cloud_providers: {}\n"));
        assert_eq!(detail.config_type.as_deref(), Some("yaml"));
        assert_eq!(detail.desc.as_deref(), Some("r-nacos description"));
        assert_eq!(detail.md5.as_deref(), Some("abc123"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_metadata_supports_no_auth_console() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(!request.to_ascii_lowercase().contains("\ntoken:"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"cloud_providers: {}\n","configType":"YAML","desc":"anonymous console metadata"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let detail = admin
            .get_config(NacosConfigKey {
                namespace: Some("ops".to_string()),
                data_id: "qilong-test".to_string(),
                group: "qilong-test".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(detail.content.as_deref(), Some("cloud_providers: {}\n"));
        assert_eq!(detail.config_type.as_deref(), Some("yaml"));
        assert_eq!(detail.desc.as_deref(), Some("anonymous console metadata"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_metadata_propagates_captcha_requirement_for_ui_retry() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            // Anonymous console detail fails and triggers captcha login flow.
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/rnacos/api/console/v2/config/info?"));
            write_text_response(&mut socket, "<html><body>login required</body></html>").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/captcha");
            write_json_response_with_captcha_token(&mut socket, r#"{"success":true,"data":"captcha-image"}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.rnacos_console_auth = crate::nacos::config::NacosRNacosConsoleAuth::UsernamePassword {
            username: "admin".to_string(),
            password: "admin".to_string(),
        };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let error = admin
            .get_config(NacosConfigKey {
                namespace: Some("ops".to_string()),
                data_id: "qilong-test".to_string(),
                group: "qilong-test".to_string(),
            })
            .await
            .unwrap_err();
        assert!(error.contains("NACOS_ERROR[rnacosConsoleCaptchaRequired]"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_list_enriches_type_and_description_from_console() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_json_response(
                &mut socket,
                r#"{"totalCount":1,"pageItems":[{"dataId":"qilong-test","group":"qilong-test","tenant":"ops"}]}"#,
            )
            .await;

            // list enrichment loads each item through console detail.
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(request.to_ascii_lowercase().contains("token: console-token"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"cloud_providers: {}\n","configType":"YAML","desc":"r-nacos description"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.rnacos_console_auth = crate::nacos::config::NacosRNacosConsoleAuth::UsernamePassword {
            username: "admin".to_string(),
            password: "admin".to_string(),
        };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let list = admin
            .list_configs(NacosConfigQuery {
                namespace: Some("ops".to_string()),
                group: None,
                group_contains: false,
                data_id: None,
                app_name: None,
                search: None,
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].config_type.as_deref(), Some("yaml"));
        assert_eq!(list.items[0].desc.as_deref(), Some("r-nacos description"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_list_enriches_description_from_no_auth_console_when_type_is_inferred() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_json_response(
                &mut socket,
                r#"{"totalCount":1,"pageItems":[{"dataId":"application.yaml","group":"DEFAULT_GROUP","tenant":"ops"}]}"#,
            )
            .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(!request.to_ascii_lowercase().contains("\ntoken:"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"value":"server:\n  port: 8848\n","configType":"YAML","desc":"anonymous list description"}}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let list = admin
            .list_configs(NacosConfigQuery {
                namespace: Some("ops".to_string()),
                group: None,
                group_contains: false,
                data_id: None,
                app_name: None,
                search: None,
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();

        assert_eq!(list.items[0].config_type.as_deref(), Some("yaml"));
        assert_eq!(list.items[0].desc.as_deref(), Some("anonymous list description"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_rnacos_lists_openapi_namespaces_without_console_url_when_health_is_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/nacos/health", "/nacos/v1/ns/operator/servers", "/nacos/v1/console/server/state"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_service_unavailable_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_json_response(&mut socket, r#"{"data":[{"namespace":"public","namespaceShowName":"public"}]}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_history_enabled = Some(false);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert!(!info.capabilities.supports_config_history);
        assert_eq!(info.capabilities.history_unavailable_reason.as_deref(), Some("historyDisabled"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_rnacos_uses_openapi_namespaces_before_captcha_protected_console() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let console_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let console_address = console_listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_json_response(&mut socket, r#""success""#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_json_response(&mut socket, r#"{"data":[]}"#).await;
        });
        let console_server = tokio::spawn(async move {
            assert!(tokio::time::timeout(Duration::from_millis(100), console_listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{console_address}");
        config.rnacos_history_enabled = Some(true);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert!(!info.capabilities.supports_config_history);
        assert_eq!(info.capabilities.history_unavailable_reason.as_deref(), Some("consoleCredentialsMissing"));
        server.await.unwrap();
        console_server.await.unwrap();
    }

    #[test]
    fn rnacos_console_endpoint_joins_terminal_rnacos_once() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.rnacos_console_addr = "https://console.example/gateway/rnacos/".to_string();
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        assert_eq!(
            admin.rnacos_console_endpoint("/rnacos/api/console/v2/login/captcha").unwrap(),
            "https://console.example/gateway/rnacos/api/console/v2/login/captcha"
        );
    }

    #[test]
    fn routes_documented_rnacos_auth_outside_the_nacos_context() {
        let mut config = test_admin_config("https://nacos.example".to_string());
        config.context_path = "/gateway/nacos".to_string();
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert_eq!(
            admin.endpoint_with_context("/rnacos/v1/auth/user/login", "/gateway/nacos").unwrap(),
            "https://nacos.example/gateway/rnacos/v1/auth/user/login"
        );
    }

    #[tokio::test]
    async fn explicit_nacos_v2_uses_canonical_auth_users_login() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/nacos/v1/auth/users/login");
            write_json_response(&mut socket, r#"{"accessToken":"nacos-token","tokenTtl":18000}"#).await;
            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/gateway/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "nacos".to_string(), password: "nacos".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert_eq!(admin.access_token().await.unwrap().as_deref(), Some("nacos-token"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn nacos_v2_password_update_reuses_login_session_cookie() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/auth/users/login");
            write_json_response_with_cookie(
                &mut socket,
                r#"{"accessToken":"nacos-token","tokenTtl":18000}"#,
                "JSESSIONID=nacos-session; Path=/nacos; HttpOnly",
            )
            .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let target = request.split_whitespace().nth(1).unwrap();
            assert!(request.starts_with("PUT "));
            assert!(target.starts_with("/nacos/v1/auth/users?"));
            assert!(target.contains("accessToken=nacos-token"));
            assert!(request.to_ascii_lowercase().contains("cookie: jsessionid=nacos-session"));
            assert!(request.contains("username=alice"));
            assert!(request.contains("newPassword=new-secret"));
            write_json_response(&mut socket, r#"{"code":0,"message":"success","data":true}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "nacos".to_string(), password: "nacos".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        admin
            .update_user(NacosUserUpdate {
                username: "alice".to_string(),
                password: Some("new-secret".to_string()),
                nickname: None,
                enabled: None,
                roles: None,
                namespace_privilege: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_nacos_v2_auth_failure_does_not_probe_rnacos() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/gateway/nacos/v1/auth/users/login", "/gateway/nacos/v1/auth/login"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_forbidden_response(&mut socket).await;
            }
            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/gateway/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "nacos".to_string(), password: "wrong".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let error = admin.access_token().await.unwrap_err();

        assert!(error.starts_with("NACOS_ERROR[authFailed]:"));
        assert!(error.contains("/v1/auth/users/login returned 403 Forbidden"));
        assert!(!error.contains("/rnacos/"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_rnacos_keeps_compatible_auth_fallback_with_proxy_context() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/gateway/nacos/v1/auth/users/login", "/gateway/nacos/v1/auth/login"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/rnacos/v1/auth/user/login");
            write_json_response(&mut socket, r#"{"accessToken":"rnacos-token","tokenTtl":18000}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::RNacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/gateway/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert_eq!(admin.access_token().await.unwrap().as_deref(), Some("rnacos-token"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn legacy_auth_probes_preserve_auth_failure_before_rnacos_not_found() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/nacos/v1/auth/users/login");
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/nacos/v1/auth/login");
            write_forbidden_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/rnacos/v1/auth/user/login");
            write_not_found_response(&mut socket).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/gateway/nacos".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "nacos".to_string(), password: "wrong".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let error = admin.access_token().await.unwrap_err();

        assert!(error.starts_with("NACOS_ERROR[authFailed]:"));
        assert!(error.contains("/v1/auth/login returned 403 Forbidden"));
        assert!(!error.contains("/v1/auth/users/login returned 404"));
        assert!(!error.contains("/rnacos/v1/auth/user/login returned 404"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn health_response_identifies_rnacos_when_v3_state_endpoint_is_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/nacos/v3/admin/core/state"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_json_response(&mut socket, "success").await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let state = admin.get_server_state().await.unwrap();
        assert_eq!(state.raw, Value::String("success".to_string()));
        assert!(state.is_rnacos_compatible);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reports_rnacos_history_unavailable_without_console_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_json_response(&mut socket, "success").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_json_response(&mut socket, r#"{"data":[]}"#).await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert!(!info.capabilities.supports_config_history);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_connection_accepts_client_openapi_when_state_and_health_are_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_service_unavailable_response(&mut socket).await;

            for expected_path in ["/nacos/v1/ns/operator/servers", "/nacos/v1/console/server/state"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_json_response(&mut socket, r#"{"data":[]}"#).await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert!(info.raw.is_none());
        assert_eq!(info.auth, "none");
        assert!(!info.capabilities.supports_config_history);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_rnacos_console_for_config_history() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/nacos/v1/cs/history/list", "/nacos/v1/cs/history", "/nacos/v1/cs/history/configs"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/captcha");
            write_json_response(&mut socket, r#"{"success":true,"data":null}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/login");
            write_json_response(&mut socket, r#"{"success":true,"data":{"token":"console-token"}}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/rnacos/api/console/v2/config/history?"));
            assert!(target.contains("tenant=public"));
            assert!(target.contains("dataId=app.yaml"));
            assert!(target.contains("group=DEFAULT_GROUP"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"totalCount":1,"list":[{"id":7,"tenant":"public","dataId":"app.yaml","group":"DEFAULT_GROUP","content":"value=1","modifiedTime":1710000000000,"opUser":"admin"}]}}"#,
            )
            .await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        *admin.token.lock().await = Some(AccessToken {
            token: "openapi-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let result = admin
            .list_config_history(NacosConfigHistoryQuery {
                namespace: Some("public".to_string()),
                data_id: "app.yaml".to_string(),
                group: "DEFAULT_GROUP".to_string(),
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.items[0].history_id, "7");
        assert_eq!(result.items[0].operator.as_deref(), Some("admin"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn loads_rnacos_history_content_for_rollback_fallback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/nacos/v1/cs/history", "/nacos/v1/cs/history/config"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/captcha");
            write_json_response(&mut socket, r#"{"success":true,"data":null}"#).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/login");
            write_json_response(&mut socket, r#"{"success":true,"data":{"token":"console-token"}}"#).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/rnacos/api/console/v2/config/history?"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"totalCount":1,"list":[{"id":7,"tenant":"public","dataId":"app.yaml","group":"DEFAULT_GROUP","content":"value=1"}]}}"#,
            )
            .await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = format!("http://{address}");
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        *admin.token.lock().await = Some(AccessToken {
            token: "openapi-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let result = admin
            .get_config_history(NacosConfigHistoryKey {
                namespace: Some("public".to_string()),
                data_id: "app.yaml".to_string(),
                group: "DEFAULT_GROUP".to_string(),
                history_id: "7".to_string(),
                nid: Some(7),
            })
            .await
            .unwrap();
        assert_eq!(result.content.as_deref(), Some("value=1"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reports_when_rnacos_console_captcha_is_enabled() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/captcha");
            write_json_response_with_captcha_token(
                &mut socket,
                r#"{"success":true,"data":"data:image/png;base64,abc"}"#,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().nth(1), Some("/rnacos/api/console/v2/login/login"));
            assert!(request.to_ascii_lowercase().contains("cookie: captcha_token=1234567890abcdeffedcba0987654321"));
            let body = request.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or_default();
            assert!(body.contains("username=admin"));
            assert!(body.contains("captcha=1234"));
            assert!(body.contains("password="));
            assert!(!body.contains("password=admin"));
            write_json_response(&mut socket, r#"{"success":true,"data":{"token":"console-token"}}"#).await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.rnacos_console_addr = format!("http://{address}");
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let captcha = admin.fetch_rnacos_console_captcha().await.unwrap();
        assert!(captcha.required);
        assert_eq!(captcha.image.as_deref(), Some("data:image/png;base64,abc"));
        admin.login_rnacos_console_with_captcha(Some("1234".to_string())).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reuses_rnacos_console_session_when_the_client_is_rebuilt() {
        let session = new_rnacos_console_session();
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.rnacos_console_addr = "http://127.0.0.1:10848".to_string();
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let first = NacosOpenApiAdmin::new_with_rnacos_console_session(config.clone(), session.clone()).unwrap();
        first.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let rebuilt = NacosOpenApiAdmin::new_with_rnacos_console_session(config, session).unwrap();

        assert_eq!(rebuilt.rnacos_console_token().await.unwrap(), "console-token");
    }

    #[tokio::test]
    async fn does_not_clear_a_newer_rnacos_console_session_after_an_old_request_fails() {
        let admin = NacosOpenApiAdmin::new(test_admin_config("http://127.0.0.1:8848".to_string())).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "new-console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        admin.clear_rnacos_console_token_if_matches("old-console-token").await;

        assert_eq!(
            admin.rnacos_console_session.lock().await.token.as_ref().map(|token| token.token.as_str()),
            Some("new-console-token")
        );
    }

    #[tokio::test]
    async fn exposes_rnacos_version_after_console_authentication() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/user/web_resources");
            write_json_response(&mut socket, r#"{"success":true,"data":{"version":"0.8.5"}}"#).await;
        });
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.rnacos_console_addr = format!("http://{address}");
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        assert_eq!(admin.rnacos_console_version_if_authenticated().await.as_deref(), Some("r-nacos 0.8.5"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn invalidates_expired_rnacos_console_session_and_requests_a_new_captcha() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/rnacos/api/console/v2/config/history"));
            write_json_response(&mut socket, r#"{"success":false,"code":"NO_LOGIN","data":null}"#).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/rnacos/api/console/v2/login/captcha");
            write_json_response_with_captcha_token(
                &mut socket,
                r#"{"success":true,"data":"data:image/png;base64,abc"}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.rnacos_console_addr = format!("http://{address}");
        config.auth =
            NacosAuthConfig::UsernamePassword { username: "admin".to_string(), password: "admin".to_string() };
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        admin.rnacos_console_session.lock().await.token = Some(RNacosConsoleToken {
            token: "expired-console-token".to_string(),
            expires_at: Instant::now() + Duration::from_secs(300),
        });

        let error = admin
            .get_rnacos_console_json(
                "/rnacos/api/console/v2/config/history",
                vec![("dataId".to_string(), "app.yaml".to_string())],
            )
            .await
            .unwrap_err();

        assert!(error.contains("[rnacosConsoleCaptchaRequired]"));
        let session = admin.rnacos_console_session.lock().await;
        assert!(session.token.is_none());
        assert!(session.captcha.is_some());
        server.await.unwrap();
    }

    #[test]
    fn parses_config_list_shapes() {
        let parsed = parse_config_list(
            serde_json::json!({
                "totalCount": 1,
                "pageItems": [{ "dataId": "app.yaml", "group": "DEFAULT_GROUP", "type": "yaml", "appName": "portal" }]
            }),
            "public".to_string(),
            1,
            20,
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].data_id, "app.yaml");
        assert_eq!(parsed.items[0].namespace, "public");
        assert_eq!(parsed.items[0].app_name.as_deref(), Some("portal"));
        assert_eq!(parsed.items[0].config_type.as_deref(), Some("yaml"));
    }

    #[test]
    fn infers_config_format_when_list_shape_omits_type() {
        let parsed = parse_config_list(
            serde_json::json!({
                "totalCount": 2,
                "pageItems": [
                    { "dataId": "application-dev.yml", "group": "DEFAULT_GROUP" },
                    { "dataId": "feature.properties", "group": "DEFAULT_GROUP", "configType": "" }
                ]
            }),
            "public".to_string(),
            1,
            20,
        );
        assert_eq!(parsed.items[0].config_type.as_deref(), Some("yaml"));
        assert_eq!(parsed.items[1].config_type.as_deref(), Some("properties"));
    }

    #[test]
    fn normalizes_txt_config_format_from_list_shape() {
        let parsed = parse_config_list(
            serde_json::json!({
                "totalCount": 2,
                "pageItems": [
                    { "dataId": "qilong-test1", "group": "qilong-test", "type": "txt" },
                    { "dataId": "qilong-test2", "group": "qilong-test", "configTypeName": "TXT" }
                ]
            }),
            "public".to_string(),
            1,
            20,
        );
        assert_eq!(parsed.items[0].config_type.as_deref(), Some("text"));
        assert_eq!(parsed.items[1].config_type.as_deref(), Some("text"));
    }

    #[test]
    fn parses_v3_config_list_data_shape() {
        let parsed = parse_config_list(
            serde_json::json!({
                "code": 0,
                "data": {
                    "totalCount": 1,
                    "pageItems": [
                        { "dataId": "app.json", "groupName": "DEFAULT_GROUP", "namespaceId": "public", "appName": "console" }
                    ]
                }
            }),
            "public".to_string(),
            1,
            20,
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].group, "DEFAULT_GROUP");
        assert_eq!(parsed.items[0].app_name.as_deref(), Some("console"));
        assert_eq!(parsed.items[0].config_type.as_deref(), Some("json"));
    }

    #[test]
    fn parses_v3_config_detail_data_shape() {
        let parsed = parse_config_detail(
            serde_json::json!({
                "code": 0,
                "data": {
                    "dataId": "ttt",
                    "groupName": "test",
                    "namespaceId": "ops",
                    "type": "text",
                    "content": "hello"
                }
            }),
            "fallback".to_string(),
            "DEFAULT_GROUP".to_string(),
            "public".to_string(),
        );
        assert_eq!(parsed.data_id, "ttt");
        assert_eq!(parsed.group, "test");
        assert_eq!(parsed.namespace, "ops");
        assert_eq!(parsed.config_type.as_deref(), Some("text"));
        assert_eq!(parsed.content.as_deref(), Some("hello"));
    }

    #[test]
    fn parses_rnacos_console_config_info_metadata() {
        let parsed = parse_config_detail(
            serde_json::json!({
                "success": true,
                "data": {
                    "value": "cloud_providers: {}\n",
                    "md5": "abc123",
                    "configType": "YAML",
                    "desc": "r-nacos description"
                }
            }),
            "qilong-test".to_string(),
            "qilong-test".to_string(),
            "ops".to_string(),
        );
        assert_eq!(parsed.data_id, "qilong-test");
        assert_eq!(parsed.group, "qilong-test");
        assert_eq!(parsed.namespace, "ops");
        assert_eq!(parsed.content.as_deref(), Some("cloud_providers: {}\n"));
        assert_eq!(parsed.config_type.as_deref(), Some("yaml"));
        assert_eq!(parsed.desc.as_deref(), Some("r-nacos description"));
        assert_eq!(parsed.md5.as_deref(), Some("abc123"));
    }

    #[test]
    fn builds_v3_publish_form_fields() {
        let (v3_form, v1_form) = build_publish_forms(
            NacosConfigUpsert {
                namespace: Some("ops".to_string()),
                data_id: "app.yaml".to_string(),
                group: "DEFAULT_GROUP".to_string(),
                content: "server:\n  port: 8080".to_string(),
                config_type: Some("yaml".to_string()),
                app_name: Some("portal".to_string()),
                desc: Some("main config".to_string()),
                tags: Some("prod,gray".to_string()),
            },
            "ops".to_string(),
        );

        assert!(v3_form.contains(&("dataId".to_string(), "app.yaml".to_string())));
        assert!(v3_form.contains(&("groupName".to_string(), "DEFAULT_GROUP".to_string())));
        assert!(v3_form.contains(&("namespaceId".to_string(), "ops".to_string())));
        assert!(v3_form.contains(&("content".to_string(), "server:\n  port: 8080".to_string())));
        assert!(v3_form.contains(&("type".to_string(), "yaml".to_string())));
        assert!(v3_form.contains(&("configTags".to_string(), "prod,gray".to_string())));
        assert!(v3_form.contains(&("config_tags".to_string(), "prod,gray".to_string())));
        assert!(v1_form.contains(&("group".to_string(), "DEFAULT_GROUP".to_string())));
        assert!(v1_form.contains(&("tenant".to_string(), "ops".to_string())));
    }

    #[test]
    fn namespace_list_error_keeps_v3_and_v1_details() {
        let err = namespace_list_error(
            "NACOS_ERROR[authFailed]: Nacos admin /v3/admin/core/namespace/list returned 403 Forbidden",
            "NACOS_ERROR[apiVersionMismatch]: Nacos admin /v1/console/namespaces returned 410 Gone",
        );
        assert!(err.starts_with("NACOS_ERROR[authFailed]:"));
        assert!(err.contains("/v3/admin/core/namespace/list returned 403 Forbidden"));
        assert!(err.contains("/v1/console/namespaces returned 410 Gone"));
    }

    #[test]
    fn parses_v1_show_all_config_detail_metadata() {
        let parsed = parse_config_detail(
            serde_json::json!({
                "dataId": "qilong-test1",
                "group": "qilong-test",
                "tenant": "opsmanage",
                "type": "yaml",
                "config_tags": "prod,gray",
                "content": "cloud_providers:\n  aliyun: {}\n"
            }),
            "fallback".to_string(),
            "DEFAULT_GROUP".to_string(),
            "public".to_string(),
        );
        assert_eq!(parsed.data_id, "qilong-test1");
        assert_eq!(parsed.group, "qilong-test");
        assert_eq!(parsed.namespace, "opsmanage");
        assert_eq!(parsed.config_type.as_deref(), Some("yaml"));
        assert_eq!(parsed.tags.as_deref(), Some("prod,gray"));
        assert_eq!(parsed.content.as_deref(), Some("cloud_providers:\n  aliyun: {}\n"));
    }

    #[test]
    fn console_detail_reads_value_and_config_type() {
        let parsed = parse_config_detail(
            serde_json::json!({
                "success": true,
                "data": {
                    "value": "{\n  \"Name\": \"Hello\"\n}",
                    "configType": "JSON",
                    "desc": "from-console"
                }
            }),
            "3432".to_string(),
            "DEFAULT_GROUP".to_string(),
            "public".to_string(),
        );
        assert_eq!(parsed.content.as_deref(), Some("{\n  \"Name\": \"Hello\"\n}"));
        assert_eq!(parsed.config_type.as_deref(), Some("json"));
        assert_eq!(parsed.desc.as_deref(), Some("from-console"));
    }

    #[test]
    fn content_field_falls_back_to_value_when_content_is_null() {
        let parsed = parse_config_detail(
            serde_json::json!({
                "dataId": "app.json",
                "group": "DEFAULT_GROUP",
                "content": null,
                "value": "from-value-field"
            }),
            "fallback".to_string(),
            "DEFAULT_GROUP".to_string(),
            "public".to_string(),
        );
        assert_eq!(parsed.content.as_deref(), Some("from-value-field"));
    }

    #[test]
    fn parses_config_history_list_shapes() {
        let parsed = parse_config_history_list(
            serde_json::json!({
                "data": {
                    "totalCount": 1,
                    "pageItems": [{
                        "id": "42",
                        "nid": 1001,
                        "dataId": "app.yaml",
                        "groupName": "DEFAULT_GROUP",
                        "namespaceId": "ops",
                        "appName": "portal",
                        "opType": "U",
                        "srcUser": "nacos",
                        "lastModifiedTime": 1710000000000i64,
                        "type": "yaml",
                        "config_tags": "gray"
                    }]
                }
            }),
            "public".to_string(),
            1,
            20,
            "fallback.yaml",
            "DEFAULT_GROUP",
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].history_id, "42");
        assert_eq!(parsed.items[0].nid, Some(1001));
        assert_eq!(parsed.items[0].data_id, "app.yaml");
        assert_eq!(parsed.items[0].group, "DEFAULT_GROUP");
        assert_eq!(parsed.items[0].namespace, "ops");
        assert_eq!(parsed.items[0].operator.as_deref(), Some("nacos"));
        assert_eq!(parsed.items[0].last_modified_time.as_deref(), Some("1710000000000"));
        assert_eq!(parsed.items[0].config_type.as_deref(), Some("yaml"));
    }

    #[test]
    fn encrypts_rnacos_console_password_with_captcha_token() {
        use aes::cipher::BlockDecryptMut;
        use cbc::Decryptor as Aes128CbcDecryptor;

        let captcha_token = "1234567890abcdeffedcba0987654321";
        let encoded = rnacos_console_password("admin", Some(captcha_token)).unwrap();
        assert_ne!(encoded, BASE64.encode("admin"));
        let ciphertext = BASE64.decode(encoded).unwrap();
        let mut buffer = vec![0u8; ciphertext.len()];
        let captcha_bytes = captcha_token.as_bytes();
        let plaintext =
            Aes128CbcDecryptor::<aes::Aes128>::new(captcha_bytes[..16].into(), captcha_bytes[16..32].into())
                .decrypt_padded_b2b_mut::<Pkcs7>(&ciphertext, &mut buffer)
                .unwrap();
        assert_eq!(plaintext, b"admin");
    }

    #[test]
    fn parses_config_history_list_array_shape() {
        let parsed = parse_config_history_list(
            serde_json::json!({
                "data": [
                    { "id": 7, "dataId": "app.yaml", "group": "DEFAULT_GROUP", "tenant": "ops", "opType": "publish" }
                ]
            }),
            "public".to_string(),
            1,
            20,
            "fallback.yaml",
            "DEFAULT_GROUP",
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].history_id, "7");
        assert_eq!(parsed.items[0].nid, Some(7));
        assert_eq!(parsed.items[0].namespace, "ops");
        assert_eq!(parsed.items[0].operation.as_deref(), Some("publish"));
    }

    #[test]
    fn parses_history_last_modified_aliases() {
        let parsed = parse_config_history_list(
            serde_json::json!({
                "data": {
                    "pageItems": [{
                        "id": 7,
                        "dataId": "app.yaml",
                        "group": "DEFAULT_GROUP",
                        "lastModified": "2026-08-11 15:07:48"
                    }, {
                        "id": 8,
                        "dataId": "app.yaml",
                        "group": "DEFAULT_GROUP",
                        "publish_time": 1786430868000i64
                    }]
                }
            }),
            "public".to_string(),
            1,
            20,
            "fallback.yaml",
            "DEFAULT_GROUP",
        );

        assert_eq!(parsed.items[0].last_modified_time.as_deref(), Some("2026-08-11 15:07:48"));
        assert_eq!(parsed.items[1].last_modified_time.as_deref(), Some("1786430868000"));
    }

    #[test]
    fn parses_config_history_detail_shape() {
        let parsed = parse_config_history_detail(
            serde_json::json!({
                "data": {
                    "dataId": "app.properties",
                    "group": "DEFAULT_GROUP",
                    "tenant": "ops",
                    "content": "server.port=8080",
                    "config_tags": "prod"
                }
            }),
            "fallback".to_string(),
            "group".to_string(),
            "public".to_string(),
        );
        assert_eq!(parsed.data_id, "app.properties");
        assert_eq!(parsed.namespace, "ops");
        assert_eq!(parsed.content.as_deref(), Some("server.port=8080"));
        assert_eq!(parsed.config_type.as_deref(), Some("properties"));
        assert_eq!(parsed.tags.as_deref(), Some("prod"));
    }

    #[test]
    fn parses_service_list_string_shape() {
        let parsed = parse_service_list(serde_json::json!({ "count": 1, "doms": ["DEFAULT_GROUP@@svc"] }), 1, 20);
        assert_eq!(parsed.items[0].service_name, "svc");
        assert_eq!(parsed.items[0].group_name.as_deref(), Some("DEFAULT_GROUP"));
    }

    #[test]
    fn parses_v3_service_list_data_shape() {
        let parsed = parse_service_list(
            serde_json::json!({
                "code": 0,
                "data": {
                    "totalCount": 1,
                    "pageItems": [
                        { "serviceName": "svc", "groupName": "DEFAULT_GROUP", "ipCount": 2 }
                    ]
                }
            }),
            1,
            20,
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].service_name, "svc");
        assert_eq!(parsed.items[0].group_name.as_deref(), Some("DEFAULT_GROUP"));
    }

    #[test]
    fn parses_catalog_service_list_shape() {
        let parsed = parse_service_list(
            serde_json::json!({
                "count": 2,
                "serviceList": [
                    { "name": "dev@@rokid-device-service", "ipCount": 3 },
                    { "serviceName": "DEFAULT_GROUP@@coze_plugin_service", "groupName": "DEFAULT_GROUP" }
                ]
            }),
            1,
            20,
        );
        assert_eq!(parsed.total_count, 2);
        assert_eq!(parsed.items[0].service_name, "rokid-device-service");
        assert_eq!(parsed.items[0].group_name.as_deref(), Some("dev"));
        assert_eq!(parsed.items[1].service_name, "coze_plugin_service");
        assert_eq!(parsed.items[1].group_name.as_deref(), Some("DEFAULT_GROUP"));
    }

    #[test]
    fn parses_v3_instance_list_data_shape() {
        let parsed = parse_instances(serde_json::json!({
            "code": 0,
            "data": {
                "hosts": [
                    { "ip": "127.0.0.1", "port": 8848, "healthy": true }
                ]
            }
        }));
        assert_eq!(parsed[0].ip, "127.0.0.1");
        assert_eq!(parsed[0].port, 8848);
        assert_eq!(parsed[0].healthy, Some(true));
    }

    #[test]
    fn parses_v1_catalog_instance_list_including_disabled_instances() {
        let parsed = parse_instances(serde_json::json!({
            "list": [{
                "ip": "192.0.2.59",
                "port": 3259,
                "clusterName": "DEFAULT",
                "healthy": false,
                "enabled": false,
                "ephemeral": false
            }],
            "count": 1
        }));

        assert_eq!(catalog_instance_count(&serde_json::json!({ "list": [], "count": 1 })), Some(1));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].ip, "192.0.2.59");
        assert_eq!(parsed[0].cluster_name.as_deref(), Some("DEFAULT"));
        assert_eq!(parsed[0].healthy, Some(false));
        assert_eq!(parsed[0].enabled, Some(false));
    }

    #[test]
    fn filters_instance_list_when_nacos_ignores_cluster_parameter() {
        let instances = parse_instances(serde_json::json!({
            "hosts": [
                { "ip": "127.0.0.1", "port": 19001, "clusterName": "blue" },
                { "ip": "127.0.0.1", "port": 19002, "clusterName": "green" }
            ]
        }));

        let filtered = filter_instances_by_clusters(instances, &["blue".to_string()]);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].cluster_name.as_deref(), Some("blue"));
    }

    #[test]
    fn parses_v1_catalog_service_clusters_and_requested_cluster_filter() {
        let clusters = parse_catalog_cluster_names(&serde_json::json!({
            "service": { "name": "svc" },
            "clusters": [
                { "name": "DEFAULT" },
                { "clusterName": "GRAY" },
                { "name": "DEFAULT" }
            ]
        }));

        assert_eq!(clusters, vec!["DEFAULT", "GRAY"]);
        assert_eq!(split_nacos_cluster_names(Some(" DEFAULT,GRAY, DEFAULT ,")), vec!["DEFAULT", "GRAY"]);
        assert!(split_nacos_cluster_names(None).is_empty());
    }

    #[tokio::test]
    async fn qualifies_group_in_v1_catalog_service_requests() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut detail_socket, _) = listener.accept().await.unwrap();
            let detail_target = read_request_target(&mut detail_socket).await;
            let detail_url = reqwest::Url::parse(&format!("http://localhost{detail_target}")).unwrap();
            let detail_params = detail_url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(detail_url.path(), "/v1/ns/catalog/service");
            assert_eq!(detail_params.get("serviceName").map(|value| value.as_ref()), Some("GRAY_GROUP@@orders"));
            assert!(!detail_params.contains_key("groupName"));
            write_json_response(&mut detail_socket, r#"{"clusters":[{"name":"DEFAULT"}]}"#).await;

            let (mut instances_socket, _) = listener.accept().await.unwrap();
            let instances_target = read_request_target(&mut instances_socket).await;
            let instances_url = reqwest::Url::parse(&format!("http://localhost{instances_target}")).unwrap();
            let instances_params = instances_url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(instances_url.path(), "/v1/ns/catalog/instances");
            assert_eq!(instances_params.get("serviceName").map(|value| value.as_ref()), Some("GRAY_GROUP@@orders"));
            assert!(!instances_params.contains_key("groupName"));
            write_json_response(&mut instances_socket, r#"{"list":[],"count":0}"#).await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        let instances = admin
            .list_v1_catalog_instances(
                &NacosInstanceQuery {
                    namespace: Some("public".to_string()),
                    service_name: "orders".to_string(),
                    group_name: Some("GRAY_GROUP".to_string()),
                    clusters: None,
                },
                "public",
            )
            .await
            .unwrap();

        assert!(instances.is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn v2_instance_list_uses_catalog_and_keeps_disabled_instances() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut detail_socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut detail_socket).await.starts_with("/nacos/v1/ns/catalog/service?"));
            write_json_response(&mut detail_socket, r#"{"clusters":[{"name":"manual"}]}"#).await;

            let (mut instances_socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut instances_socket).await.starts_with("/nacos/v1/ns/catalog/instances?"));
            write_json_response(
                &mut instances_socket,
                r#"{"list":[{"ip":"127.0.0.1","port":19101,"clusterName":"manual","healthy":false,"enabled":false,"ephemeral":false}],"count":1}"#,
            )
            .await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let instances = admin
            .list_instances(NacosInstanceQuery {
                namespace: Some("public".to_string()),
                service_name: "dbx-ui-crud".to_string(),
                group_name: Some("DBX_E2E".to_string()),
                clusters: None,
            })
            .await
            .unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].enabled, Some(false));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dashboard_combines_metrics_nodes_and_namespace_totals() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut paths = HashSet::new();
            for _ in 0..6 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let target = read_request_target(&mut socket).await;
                let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
                paths.insert(url.path().to_string());
                let body = match url.path() {
                    "/v3/admin/ns/ops/metrics" => {
                        r#"{"code":0,"data":{"status":"UP","serviceCount":8,"instanceCount":13,"clientCount":5}}"#
                    }
                    "/v3/admin/core/cluster/node/list" => {
                        r#"{"code":0,"data":[{"address":"127.0.0.1:8848","ip":"127.0.0.1","port":8848,"state":"UP"}]}"#
                    }
                    "/v3/admin/core/namespace/list" => {
                        r#"{"code":0,"data":[{"namespace":"dev","namespaceShowName":"Development"}]}"#
                    }
                    "/v3/admin/cs/config/list" => r#"{"code":0,"data":{"totalCount":21,"pageItems":[]}}"#,
                    "/v3/admin/ns/service/list" => r#"{"code":0,"data":{"count":3,"serviceList":[]}}"#,
                    "/actuator/prometheus" => {
                        "# TYPE system_cpu_usage gauge\nsystem_cpu_usage 0.25\n# TYPE nacos_monitor gauge\nnacos_monitor{module=\"config\",name=\"configCount\"} 12\nnacos_monitor{module=\"naming\",name=\"serviceCount\"} 4\nnacos_monitor{module=\"naming\",name=\"ipCount\"} 14\n"
                    }
                    path => panic!("unexpected dashboard request path: {path}"),
                };
                write_json_response(&mut socket, body).await;
            }
            paths
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        let snapshot = admin.get_dashboard(NacosDashboardQuery { namespace: Some("dev".to_string()) }).await.unwrap();

        assert_eq!(snapshot.namespace, "dev");
        assert_eq!(snapshot.namespace_count, Some(2));
        assert_eq!(snapshot.config_count, Some(21));
        assert_eq!(snapshot.service_count, Some(3));
        assert_eq!(snapshot.metrics.as_ref().and_then(|metrics| metrics.instance_count), Some(14));
        assert_eq!(snapshot.prometheus.as_ref().and_then(|metrics| metrics.resource.cpu_ratio), Some(0.25));
        assert_eq!(snapshot.nodes.len(), 1);
        assert!(snapshot.warnings.is_empty());
        assert_eq!(server.await.unwrap().len(), 6);
    }

    #[test]
    fn parses_namespace_list_shape() {
        let parsed = parse_namespaces(serde_json::json!({
            "code": 200,
            "data": [
                { "namespace": "", "namespaceShowName": "public", "configCount": 2 },
                { "namespace": "dev", "namespaceShowName": "Development", "namespaceDesc": "dev ns" }
            ]
        }));
        assert_eq!(parsed[0].namespace_show_name, "public");
        assert_eq!(parsed[1].namespace, "dev");
        assert_eq!(parsed[1].namespace_desc.as_deref(), Some("dev ns"));
    }

    #[test]
    fn does_not_add_a_second_default_namespace_when_v3_returns_public() {
        let parsed = parse_namespaces(serde_json::json!({
            "code": 0,
            "data": [{ "namespace": "public", "namespaceShowName": "public" }]
        }));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].namespace, "public");
    }

    #[test]
    fn parses_v3_namespace_page_shape() {
        let parsed = parse_namespaces(serde_json::json!({
            "code": 0,
            "data": {
                "pageItems": [
                    { "namespaceId": "dev", "namespaceName": "Development", "namespaceDesc": "dev ns" }
                ]
            }
        }));
        assert_eq!(parsed[0].namespace, "");
        assert_eq!(parsed[1].namespace, "dev");
        assert_eq!(parsed[1].namespace_show_name, "Development");
    }

    #[test]
    fn parses_v3_dashboard_metrics_shape() {
        let parsed = parse_dashboard_metrics(serde_json::json!({
            "code": 0,
            "data": {
                "status": "UP",
                "serviceCount": 12,
                "instanceCount": 34,
                "clientCount": "5",
                "cpu": 0.25,
                "mem": "0.5"
            }
        }));

        assert_eq!(parsed.status.as_deref(), Some("UP"));
        assert_eq!(parsed.service_count, Some(12));
        assert_eq!(parsed.instance_count, Some(34));
        assert_eq!(parsed.client_count, Some(5));
        assert_eq!(parsed.cpu, Some(0.25));
        assert_eq!(parsed.mem, Some(0.5));

        let status_only = parse_dashboard_metrics(serde_json::json!({ "code": 0, "data": "UP" }));
        assert_eq!(status_only.status.as_deref(), Some("UP"));
    }

    #[test]
    fn parses_v1_and_v3_cluster_node_shapes() {
        let v1 = parse_cluster_nodes(serde_json::json!({
            "servers": [{
                "ip": "192.0.2.1",
                "servePort": 8848,
                "alive": true,
                "site": "unknown",
                "lastRefTimeStr": "2026-07-26 10:00:00"
            }]
        }));
        assert_eq!(v1[0].address, "192.0.2.1:8848");
        assert_eq!(v1[0].alive, Some(true));
        assert_eq!(v1[0].last_refresh_time.as_deref(), Some("2026-07-26 10:00:00"));

        let v3 = parse_cluster_nodes(serde_json::json!({
            "code": 0,
            "data": [{
                "address": "192.0.2.2:8848",
                "ip": "192.0.2.2",
                "port": 8848,
                "state": "UP",
                "extendInfo": { "lastRefreshTime": 1785031200000_u64 }
            }]
        }));
        assert_eq!(v3[0].address, "192.0.2.2:8848");
        assert_eq!(v3[0].alive, Some(true));
        assert_eq!(v3[0].last_refresh_time.as_deref(), Some("1785031200000"));
    }

    #[test]
    fn validates_raw_api_paths() {
        for path in ["/v1/cs/configs", "/v2/console/example", "/v3/admin/core/state"] {
            validate_raw_api_path(path).unwrap();
        }

        for path in [
            "",
            "v1/cs/configs",
            "https://nacos.example.com/v1/cs/configs",
            "//nacos.example.com/v1/cs/configs",
            "/api/v1/cs/configs",
            "/v1/../operator",
            "/v3\\console\\server",
        ] {
            let err = validate_raw_api_path(path).unwrap_err();
            assert!(err.contains("NACOS_ERROR[invalidRawPath]"), "{path}: {err}");
        }
    }

    #[test]
    fn classifies_common_nacos_errors() {
        assert_eq!(classify_nacos_error("401 Unauthorized invalid access token"), "authFailed");
        assert_eq!(classify_nacos_error("No static resource nacos/v3/admin/core/state"), "contextPathMismatch");
        assert_eq!(
            classify_nacos_error(
                r#"410 Gone {"message":"Current API will be deprecated","path":"/v1/console/namespaces"}"#
            ),
            "apiVersionMismatch"
        );
        assert_eq!(classify_nacos_error("404 Not Found"), "apiVersionMismatch");
        assert_eq!(classify_nacos_error("connection refused"), "connectionFailed");
    }

    #[test]
    fn treats_gateway_wrapped_missing_content_search_routes_as_unsupported() {
        assert!(content_search_endpoint_is_unsupported(
            r#"NACOS_ERROR[contextPathMismatch]: Nacos admin /v3/admin/cs/config/list returned 500 Internal Server Error: {"message":"No static resource v3/admin/cs/config/list."}"#
        ));
        assert!(!content_search_endpoint_is_unsupported(
            "NACOS_ERROR[requestFailed]: Nacos admin /v3/admin/cs/config/list returned 500 Internal Server Error: database unavailable"
        ));
    }

    #[test]
    fn instance_update_form_keeps_identity_separate_from_the_patch() {
        let form = instance_update_form(
            "public".to_string(),
            NacosInstanceUpdateRequest {
                target: NacosInstanceRef {
                    namespace: Some("public".to_string()),
                    service_name: "api".to_string(),
                    ip: "127.0.0.1".to_string(),
                    port: 8080,
                    group_name: Some("DBX_TEST".to_string()),
                    cluster_name: Some("blue".to_string()),
                    ephemeral: Some(false),
                },
                patch: NacosInstancePatch {
                    weight: Some(2.5),
                    metadata: Some(serde_json::json!({ "role": "api" })),
                    ..Default::default()
                },
            },
        );
        let form = form.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(form.get("ephemeral").map(String::as_str), Some("false"));
        assert_eq!(form.get("weight").map(String::as_str), Some("2.5"));
        assert!(form.contains_key("metadata"));
        assert!(!form.contains_key("enabled"));
        assert!(!form.contains_key("healthy"));
    }

    #[test]
    fn instance_registration_form_is_always_persistent() {
        let form = instance_registration_form(
            "public".to_string(),
            NacosInstanceRegistration {
                namespace: Some("public".to_string()),
                service_name: "api".to_string(),
                ip: "127.0.0.1".to_string(),
                port: 8080,
                group_name: Some("DBX_TEST".to_string()),
                cluster_name: Some("manual".to_string()),
                weight: Some(1.0),
                metadata: Some(serde_json::json!({})),
            },
        );
        let form = form.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(form.get("ephemeral").map(String::as_str), Some("false"));
    }

    #[test]
    fn management_instance_deduplication_includes_full_identity() {
        let instance = NacosInstanceInfo {
            ip: "127.0.0.1".to_string(),
            port: 8080,
            service_name: Some("api".to_string()),
            cluster_name: Some("blue".to_string()),
            group_name: Some("DBX_TEST".to_string()),
            healthy: Some(true),
            enabled: Some(true),
            ephemeral: None,
            weight: Some(1.0),
            metadata: serde_json::json!({}),
        };
        let instances = deduplicate_management_instances(
            vec![
                instance.clone(),
                NacosInstanceInfo { ephemeral: Some(false), ..instance.clone() },
                NacosInstanceInfo { ephemeral: Some(true), ..instance.clone() },
                NacosInstanceInfo { group_name: Some("OTHER_GROUP".to_string()), ..instance.clone() },
                NacosInstanceInfo { service_name: Some("worker".to_string()), ..instance.clone() },
                instance,
            ],
            "public",
            Some("DBX_TEST"),
            "api",
        );
        assert_eq!(instances.len(), 5);
    }

    #[test]
    fn cluster_names_support_catalog_arrays_and_service_detail_maps() {
        assert_eq!(
            parse_catalog_cluster_names(&serde_json::json!({
                "data": {
                    "clusters": [{ "clusterName": "blue" }],
                    "clusterMap": { "blue": {}, "green": {} }
                }
            })),
            vec!["blue".to_string(), "green".to_string()]
        );
    }

    #[test]
    fn rnacos_requires_console_management_view_for_safe_service_deletion() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        let capabilities = admin.service_capabilities();
        assert!(capabilities.list_services.supported);
        assert!(capabilities.list_instances.supported);
        assert!(capabilities.create_service.supported);
        assert!(capabilities.update_service.supported);
        assert!(!capabilities.delete_service.supported);
        assert_eq!(capabilities.delete_service.reason, Some(NacosCapabilityReason::EndpointUnavailable));
        assert!(capabilities.update_instance.supported);
        assert!(capabilities.register_instance.supported);
        assert!(capabilities.deregister_instance.supported);
    }

    #[tokio::test]
    async fn rnacos_service_delete_guard_does_not_fall_back_to_lossy_discovery() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.implementation = Some(NacosImplementation::RNacos);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let error = admin
            .list_instances_for_service_delete(NacosInstanceQuery {
                namespace: Some("public".to_string()),
                service_name: "orders".to_string(),
                group_name: None,
                clusters: None,
            })
            .await
            .unwrap_err();

        assert!(error.contains("r-nacos service deletion requires a configured r-nacos console address"));
    }

    #[test]
    fn rnacos_console_enables_safe_service_deletion_capability() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.implementation = Some(NacosImplementation::RNacos);
        config.rnacos_console_addr = "http://127.0.0.1:10848".to_string();
        let capabilities = NacosOpenApiAdmin::new(config).unwrap().service_capabilities();
        assert!(capabilities.delete_service.supported);
    }

    #[test]
    fn official_v2_and_v3_expose_the_verified_management_matrix() {
        for version_mode in [NacosVersionMode::V2, NacosVersionMode::V3] {
            let supports_health_override = version_mode == NacosVersionMode::V2;
            let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
            config.implementation = Some(NacosImplementation::Nacos);
            config.version_mode = Some(version_mode);
            let capabilities = NacosOpenApiAdmin::new(config).unwrap().service_capabilities();
            assert!(capabilities.list_services.supported);
            assert!(capabilities.get_service.supported);
            assert!(capabilities.create_service.supported);
            assert!(capabilities.update_service.supported);
            assert!(capabilities.delete_service.supported);
            assert!(capabilities.list_instances.supported);
            assert!(capabilities.update_instance.supported);
            assert_eq!(capabilities.update_instance_health.supported, supports_health_override);
            assert!(capabilities.register_instance.supported);
            assert!(capabilities.deregister_instance.supported);
        }
    }

    #[test]
    fn v3_console_plane_exposes_only_verified_instance_mutations() {
        let mut config = test_admin_config("http://127.0.0.1:8080".to_string());
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V3);
        config.api_plane = Some(NacosApiPlane::Console);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert!(admin.api_path_allowed("/v3/console/ns/service/list"));
        assert!(admin.api_path_allowed("/v3/auth/user/login"));
        assert!(!admin.api_path_allowed("/v3/admin/ns/service/list"));
        let capabilities = admin.service_capabilities();
        assert!(capabilities.update_instance.supported);
        assert!(!capabilities.update_instance_health.supported);
        assert!(!capabilities.register_instance.supported);
        assert!(!capabilities.deregister_instance.supported);
    }

    #[test]
    fn legacy_auto_mode_never_falls_back_across_api_generations() {
        let mut auto = test_admin_config("http://127.0.0.1:8848".to_string());
        auto.version_mode = Some(NacosVersionMode::Auto);
        let auto = NacosOpenApiAdmin::new(auto).unwrap();
        assert!(!auto.should_try_next_candidate("NACOS_ERROR[apiVersionMismatch]: missing"));
        assert!(!auto.should_try_next_candidate("NACOS_ERROR[contextPathMismatch]: missing"));
        assert!(!auto.should_try_next_candidate("NACOS_ERROR[authFailed]: forbidden"));
        assert!(!auto.should_try_next_candidate("NACOS_ERROR[requestFailed]: selector error"));
        assert!(auto.api_path_allowed("/v1/ns/service"));
        assert!(!auto.api_path_allowed("/v3/admin/ns/service"));

        let mut explicit = test_admin_config("http://127.0.0.1:8848".to_string());
        explicit.version_mode = Some(NacosVersionMode::V3);
        let explicit = NacosOpenApiAdmin::new(explicit).unwrap();
        assert!(!explicit.should_try_next_candidate("NACOS_ERROR[apiVersionMismatch]: missing"));
    }

    #[test]
    fn permission_scope_preserves_public_namespace_and_raw_custom_resources() {
        assert_eq!(
            parse_permission_scope(":*:*").unwrap(),
            NacosPermissionScope {
                kind: NacosPermissionScopeKind::Namespace,
                namespace_id: Some("public".to_string()),
            }
        );
        assert_eq!(
            parse_permission_scope("team-a:*:*").unwrap(),
            NacosPermissionScope {
                kind: NacosPermissionScopeKind::Namespace,
                namespace_id: Some("team-a".to_string()),
            }
        );
        assert_eq!(parse_permission_scope("*:*:*").unwrap().kind, NacosPermissionScopeKind::Global);
        assert_eq!(parse_permission_scope("team-a:group:data").unwrap().kind, NacosPermissionScopeKind::Custom);
        assert_eq!(parse_permission_scope("team-a:GROUP_A:*").unwrap().kind, NacosPermissionScopeKind::Custom);
    }

    #[test]
    fn rnacos_user_payload_uses_only_writable_namespace_privilege_fields() {
        let payload = rnacos_user_payload(
            "alice",
            None,
            Some("Alice"),
            Some(true),
            Some(&["0".to_string(), "2".to_string()]),
            Some(&NacosNamespacePrivilege {
                enabled: false,
                whitelist_is_all: false,
                whitelist: vec!["team-a".to_string()],
                blacklist_is_all: false,
                blacklist: vec!["team-b".to_string()],
            }),
            false,
        );

        assert_eq!(payload["enable"], true);
        assert_eq!(payload["roles"], "0,2");
        assert_eq!(payload["namespacePrivilegeParam"]["whitelistIsAll"], false);
        assert_eq!(payload["namespacePrivilegeParam"]["whitelist"], serde_json::json!(["team-a"]));
        assert_eq!(payload["namespacePrivilegeParam"]["blacklistIsAll"], false);
        assert_eq!(payload["namespacePrivilegeParam"]["blacklist"], serde_json::json!(["team-b"]));
        assert!(payload["namespacePrivilegeParam"].get("enabled").is_none());
    }

    #[test]
    fn rnacos_user_list_preserves_roles_and_derived_privilege_state() {
        let users = parse_user_list(
            serde_json::json!({
                "data": {
                    "totalCount": 1,
                    "list": [{
                        "username": "alice",
                        "roles": ["0", "2"],
                        "namespacePrivilege": {
                            "enabled": false,
                            "whitelistIsAll": true,
                            "whitelist": [],
                            "blacklistIsAll": false,
                            "blacklist": ["team-b"]
                        }
                    }]
                }
            }),
            1,
            20,
        );

        assert_eq!(users.total_count, 1);
        assert_eq!(users.items[0].roles, vec!["0", "2"]);
        let privilege = users.items[0].namespace_privilege.as_ref().unwrap();
        assert!(!privilege.enabled);
        assert!(privilege.whitelist_is_all);
        assert_eq!(privilege.blacklist, vec!["team-b"]);
    }

    #[test]
    fn official_nacos_v2_and_v3_share_the_enhanced_access_workspace() {
        let mut v2 = test_admin_config("http://127.0.0.1:8848".to_string());
        v2.version_mode = Some(NacosVersionMode::V2);
        let v2 = NacosOpenApiAdmin::new(v2).unwrap().access_control_capabilities();
        assert!(v2.enhanced_workspace);
        assert!(v2.list_permissions.supported);
        assert!(v2.grant_permission.supported);
        assert!(v2.revoke_permission.supported);

        let mut v3 = test_admin_config("http://127.0.0.1:8848".to_string());
        v3.version_mode = Some(NacosVersionMode::V3);
        let v3 = NacosOpenApiAdmin::new(v3).unwrap().access_control_capabilities();
        assert!(v3.enhanced_workspace);
        assert!(v3.list_permissions.supported);
        assert!(v3.grant_permission.supported);
        assert!(v3.revoke_permission.supported);
    }

    #[test]
    fn access_control_probe_classifies_authorization_failures() {
        assert_eq!(
            access_control_probe_reason("NACOS_ERROR[authFailed]: 403 Forbidden: access denied"),
            NacosCapabilityReason::PermissionDenied
        );
        assert_eq!(
            access_control_probe_reason("NACOS_ERROR[invalidResponse]: endpoint returned 404 Not Found"),
            NacosCapabilityReason::EndpointUnavailable
        );
    }

    #[test]
    fn unverified_write_capability_fails_closed() {
        let capability = write_capability(&NacosOperationCapability::supported(), false, true);
        assert!(!capability.supported);
        assert_eq!(capability.reason, Some(NacosCapabilityReason::NotVerified));
    }

    #[tokio::test]
    async fn official_nacos_v2_uses_v1_permission_endpoints() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/nacos/v1/auth/permissions?"));
            assert!(target.contains("pageNo=1"));
            assert!(target.contains("pageSize=20"));
            assert!(target.contains("role=app_developer"));
            write_json_response(
                &mut socket,
                r#"{"totalCount":1,"pageItems":[{"role":"app_developer","resource":"team-a:*:*","action":"rw"}]}"#,
            )
            .await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("POST /nacos/v1/auth/permissions HTTP/1.1"));
            assert!(request.contains("role=app_developer"));
            assert!(request.contains("action=rw"));
            write_text_response(&mut socket, "ok").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let target = read_request_target(&mut socket).await;
            assert!(target.starts_with("/nacos/v1/auth/permissions?"));
            assert!(target.contains("role=app_developer"));
            assert!(target.contains("action=rw"));
            write_text_response(&mut socket, "ok").await;
        });
        let mut config = test_admin_config(format!("http://{address}"));
        config.implementation = Some(NacosImplementation::Nacos);
        config.version_mode = Some(NacosVersionMode::V2);
        config.context_path = "/nacos".to_string();
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let listed = admin
            .list_permissions(NacosPermissionQuery {
                role: Some("app_developer".to_string()),
                resource: None,
                page_no: Some(1),
                page_size: Some(20),
            })
            .await
            .unwrap();
        assert_eq!(listed.total_count, 1);
        let permission = listed.items.into_iter().next().unwrap();
        assert_eq!(permission.resource_raw, "team-a:*:*");

        admin.grant_permission(permission.clone()).await.unwrap();
        admin.revoke_permission(permission).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn service_creation_requires_an_explicit_group() {
        let mut config = test_admin_config("http://127.0.0.1:9".to_string());
        config.version_mode = Some(NacosVersionMode::V2);
        let admin = NacosOpenApiAdmin::new(config).unwrap();
        let error = admin
            .create_service(NacosServiceUpsert {
                namespace: Some("public".to_string()),
                service_name: "api".to_string(),
                group_name: Some("  ".to_string()),
                metadata: Some(serde_json::json!({})),
                protect_threshold: Some(0.0),
                selector: None,
                ephemeral: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("group name is required"));
    }
}
