use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::Encryptor as Aes128CbcEncryptor;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::nacos::config::{NacosAdminConfig, NacosAuthConfig, NacosImplementation, NacosVersionMode};
use crate::nacos::port::NacosAdmin;
use crate::nacos::types::*;

const REQUEST_TIMEOUT_SECS: u64 = 30;
// Matches r-nacos' default RNACOS_CONSOLE_LOGIN_TIMEOUT. If an installation
// uses a shorter timeout, the console's NO_LOGIN response invalidates this
// optimistic cache and starts a fresh login flow.
pub(crate) const RNACOS_CONSOLE_SESSION_CACHE_SECS: u64 = 86_400;
const MAX_RAW_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const NACOS_ERROR_PREFIX: &str = "NACOS_ERROR";

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
}

impl NacosOpenApiAdmin {
    pub fn new(cfg: NacosAdminConfig) -> Result<Self, String> {
        Self::new_with_rnacos_console_session(cfg, new_rnacos_console_session())
    }

    pub(crate) fn new_with_rnacos_console_session(
        cfg: NacosAdminConfig,
        rnacos_console_session: RNacosConsoleSessionHandle,
    ) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
        if cfg.tls_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().map_err(|e| format!("Failed to build Nacos HTTP client: {e}"))?;
        Ok(Self { cfg, http, token: Mutex::new(None), rnacos_console_session })
    }

    fn endpoint_with_context(&self, path: &str, context_path: &str) -> Result<String, String> {
        let path = normalize_api_path(path);
        let context_path = normalize_api_path(context_path).trim_end_matches('/').to_string();
        let base = format!("{}{}", self.cfg.server_addr, context_path);
        let base = base.trim_end_matches('/');
        let full = if path.starts_with("/nacos/") && context_path == "/nacos" {
            format!("{}{}", self.cfg.server_addr, path)
        } else if path.starts_with("/rnacos/") && context_path.ends_with("/nacos") {
            // r-nacos documents this auth endpoint outside the Nacos-compatible
            // `/nacos` context. Preserve an optional proxy prefix such as
            // `/gateway/nacos` while replacing that final segment.
            let proxy_prefix = context_path.strip_suffix("/nacos").unwrap_or(&context_path);
            format!("{}{}{}", self.cfg.server_addr, proxy_prefix, path)
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
    ) -> Result<reqwest::Response, String> {
        let resp = self.send_once(method.clone(), path, &self.cfg.context_path, query, form, body).await?;
        if !self.should_retry_without_context(resp.status()) {
            return Ok(resp);
        }

        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        if self.cfg.context_path.trim().is_empty() || !looks_like_wrong_context_path(&detail, &self.cfg.context_path) {
            return Err(format!("Nacos admin {path} returned {status}: {}", detail.trim()));
        }
        self.send_once(method, path, "", query, form, body).await
    }

    async fn send_once(
        &self,
        method: reqwest::Method,
        path: &str,
        context_path: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        body: Option<&Value>,
    ) -> Result<reqwest::Response, String> {
        let mut req = self.http.request(method, self.endpoint_with_context(path, context_path)?).query(query);
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
        const NACOS_PATHS: &[&str] = &["/v1/auth/login", "/v3/auth/user/login"];
        const COMPATIBLE_PATHS: &[&str] = &["/v1/auth/login", "/v3/auth/user/login", "/rnacos/v1/auth/user/login"];

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
            match self.send_with_context_fallback(reqwest::Method::POST, path, &[], Some(&form), None).await {
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
        if let Some(token) = self.access_token().await? {
            query.push(("accessToken".to_string(), token));
        }
        self.send_with_context_fallback(method, path, &query, form.as_deref(), body.as_ref()).await
    }

    async fn get_json(&self, path: &str, query: Vec<(String, String)>) -> Result<Value, String> {
        let resp = self.request(reqwest::Method::GET, path, query, None, None).await?;
        let resp = error_for_status(resp, path).await?;
        response_json_or_text(resp).await
    }

    async fn get_json_without_auth(&self, path: &str, query: Vec<(String, String)>) -> Result<Value, String> {
        let resp = self.send_with_context_fallback(reqwest::Method::GET, path, &query, None, None).await?;
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

    async fn list_rnacos_console_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
        let value = self.get_rnacos_console_json("/rnacos/api/console/v2/namespaces/list", Vec::new()).await?;
        Ok(parse_namespaces(value))
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

    /// r-nacos's Nacos-compatible configuration API returns the raw content
    /// only. The independent console keeps the user-facing metadata such as
    /// `configType` and `desc`, so enrich that compatibility response when a
    /// console has been configured. Metadata is deliberately best-effort for
    /// network/version failures. A CAPTCHA requirement is propagated so the UI
    /// can authenticate once and retry the interrupted list/detail request.
    async fn enrich_rnacos_config_metadata(&self, mut config: NacosConfigItem) -> Result<NacosConfigItem, String> {
        if !self.is_explicit_rnacos()
            || (config.config_type.is_some() && config.desc.is_some())
            || self.cfg.rnacos_console_addr.is_empty()
        {
            return Ok(config);
        }

        let metadata = self
            .get_rnacos_console_metadata_json(
                "/rnacos/api/console/v2/config/info",
                vec![
                    ("tenant".to_string(), config.namespace.clone()),
                    ("dataId".to_string(), config.data_id.clone()),
                    ("group".to_string(), config.group.clone()),
                ],
            )
            .await
            .map(|value| {
                parse_config_detail(value, config.data_id.clone(), config.group.clone(), config.namespace.clone())
            });

        let metadata = match metadata {
            Ok(metadata) => metadata,
            Err(error) if error.contains("[rnacosConsoleCaptchaRequired]") => return Err(error),
            // Metadata remains optional. Network, permission, or version
            // mismatches must not hide configuration content obtained from
            // the compatible OpenAPI.
            Err(_) => return Ok(config),
        };
        if config.desc.is_none() {
            config.desc = metadata.desc;
        }
        if config.config_type.is_none() {
            config.config_type = metadata.config_type;
        }
        if config.md5.is_none() {
            config.md5 = metadata.md5;
        }
        if config.content.is_none() {
            config.content = metadata.content;
        }
        Ok(config)
    }

    async fn get_server_state(&self) -> Result<NacosServerStateProbe, String> {
        let mut errors = Vec::new();
        // r-nacos implements the Nacos client OpenAPI but not the console state endpoints.
        // Its documented health endpoint is mounted below the same `/nacos` context path,
        // so keep it last to preserve the richer official-Nacos state response when available.
        let paths = if matches!(self.cfg.implementation, Some(NacosImplementation::RNacos)) {
            ["/health", "/v3/console/server/state", "/v1/ns/operator/servers", "/v1/console/server/state"]
        } else {
            ["/v3/console/server/state", "/v1/ns/operator/servers", "/v1/console/server/state", "/health"]
        };
        for path in paths {
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

    fn api_path_allowed(&self, path: &str) -> bool {
        match self.cfg.version_mode.as_ref() {
            Some(NacosVersionMode::V2) => !path.starts_with("/v3/"),
            Some(NacosVersionMode::V3) => !path.starts_with("/v1/") && !path.starts_with("/v2/"),
            Some(NacosVersionMode::Auto) | None => true,
        }
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
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        push_optional(&mut v3_params, "appName", Some(app_name.to_string()));
        let mut attempts = vec![("/v3/console/cs/config/list", v3_params)];
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

    async fn list_configs_by_client_filter(
        &self,
        namespace: String,
        group: Option<String>,
        data_id_filter: Option<String>,
        app_name_filter: Option<String>,
        page_no: u32,
        page_size: u32,
    ) -> Result<NacosConfigList, String> {
        let Some(filter) = data_id_filter.map(|value| value.to_lowercase()).filter(|value| !value.is_empty()) else {
            return Ok(NacosConfigList { page_no, page_size, total_count: 0, items: Vec::new() });
        };
        let group = group.unwrap_or_default();
        let app_name = app_name_filter.unwrap_or_default();
        let scan_page_size = page_size.max(self.cfg.page_size).clamp(100, 500);
        let mut matched = Vec::new();
        let mut seen = HashSet::new();
        let mut current_page = 1;

        loop {
            let value =
                self.get_config_list_value(&namespace, "", &group, &app_name, current_page, scan_page_size).await?;
            let list = parse_config_list(value, namespace.clone(), current_page, scan_page_size);
            let total_count = list.total_count;
            let empty = list.items.is_empty();
            let before = seen.len();
            for item in list.items {
                let identity = (item.namespace.clone(), item.group.clone(), item.data_id.clone());
                if seen.insert(identity) && item.data_id.to_lowercase().contains(&filter) {
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
            let needs_rnacos_description =
                self.is_explicit_rnacos() && item.desc.is_none() && !self.cfg.rnacos_console_addr.is_empty();
            if item.config_type.is_some() && !needs_rnacos_description {
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

        let mut seen = HashSet::new();
        instances.retain(|instance| seen.insert((instance.ip.clone(), instance.port, instance.cluster_name.clone())));
        Ok(instances)
    }

    async fn get_dashboard_nodes(&self) -> Result<Vec<NacosClusterNode>, String> {
        // r-nacos does not implement the official Nacos cluster-node Admin
        // APIs. An empty list represents this unsupported optional capability
        // without turning every dashboard refresh into a false warning.
        if self.is_explicit_rnacos() {
            return Ok(Vec::new());
        }

        self.get_json_from_candidates(
            "load Nacos cluster nodes",
            vec![
                ("/v3/admin/core/cluster/node/list", Vec::new()),
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
            return format!(
                "{error} Check the connection address: Nacos 3 dashboard APIs use the Server / Admin API endpoint \
                 (normally http://host:8848/nacos), not the port 8080 Console."
            );
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
    async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
        // Server-state endpoints are console APIs and r-nacos deliberately only
        // guarantees the client OpenAPI. Treat state/health as best-effort;
        // successful authentication and namespace access below prove that this
        // connection can perform the DBX operations it exposes.
        let state = self.get_server_state().await.ok();
        let _ = self.access_token().await?;
        let _ = self.list_namespaces().await?;
        let mut capabilities = NacosCapabilities::default();
        let is_rnacos = self.is_explicit_rnacos() || state.as_ref().is_some_and(|state| state.is_rnacos_compatible);
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
        let server_version = if is_rnacos {
            self.rnacos_console_version_if_authenticated().await
        } else {
            state.as_ref().and_then(|state| extract_server_version(&state.raw))
        };
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

    async fn get_rnacos_console_captcha(&self) -> Result<NacosRNacosConsoleCaptcha, String> {
        self.fetch_rnacos_console_captcha().await
    }

    async fn login_rnacos_console(&self, captcha: Option<String>) -> Result<(), String> {
        self.login_rnacos_console_with_captcha(captcha).await.map(|_| ())
    }

    async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
        if self.is_explicit_rnacos() {
            // r-nacos v0.6.12 exposes the Nacos-compatible namespace API on
            // the main OpenAPI service. This keeps the connection tree usable
            // without a separately configured console, including consoles
            // that require an interactive CAPTCHA.
            match self.get_json("/v1/console/namespaces", Vec::new()).await {
                Ok(value) => return Ok(parse_namespaces(value)),
                Err(openapi_error) if self.cfg.rnacos_console_addr.is_empty() => return Err(openapi_error),
                Err(openapi_error) => {
                    return self.list_rnacos_console_namespaces().await.map_err(|console_error| {
                        format!(
                            "Failed to list r-nacos namespaces through the OpenAPI endpoint ({openapi_error}) or console fallback ({console_error})"
                        )
                    });
                }
            }
        }
        let value = self
            .get_json_from_candidates(
                "list Nacos namespaces",
                vec![("/v3/console/core/namespace/list", Vec::new()), ("/v1/console/namespaces", Vec::new())],
            )
            .await?;
        Ok(parse_namespaces(value))
    }

    async fn create_namespace(&self, req: NacosNamespaceCreate) -> Result<(), String> {
        let namespace_id = req.namespace_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
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
        if let Some(namespace_id) = namespace_id {
            // Nacos 3.x Console API uses `customNamespaceId`; passing only
            // `namespaceId` is accepted but ignored and causes a generated UUID.
            v3_form.push(("customNamespaceId".to_string(), namespace_id.clone()));
            v3_form.push(("namespaceId".to_string(), namespace_id.clone()));
            v1_form.push(("customNamespaceId".to_string(), namespace_id.clone()));
            v1_form.push(("namespaceId".to_string(), namespace_id));
        }

        self.submit_form_candidates(
            "create Nacos namespace",
            reqwest::Method::POST,
            vec![
                ("/v3/console/core/namespace", v3_form.clone()),
                ("/v3/console/core/namespace/create", v3_form),
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
                ("/v3/console/core/namespace", v3_form.clone()),
                ("/v3/console/core/namespace/update", v3_form),
                ("/v1/console/namespaces", v1_form.clone()),
                ("/v1/console/namespaces/update", v1_form),
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
        let group_filter = query.group.clone();
        let group = group_filter.clone().unwrap_or_default();
        let app_name_filter = query.app_name.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let app_name = app_name_filter.clone().unwrap_or_default();
        let value = self.get_config_list_value(&namespace, &search, &group, &app_name, page_no, page_size).await?;
        let parsed =
            self.enrich_missing_config_formats(parse_config_list(value, namespace.clone(), page_no, page_size)).await;
        if data_id_filter.is_some() && parsed.items.is_empty() {
            let fallback = self
                .list_configs_by_client_filter(
                    namespace,
                    group_filter,
                    data_id_filter,
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
        let attempts = [
            (
                "/v3/admin/cs/config/list",
                vec![
                    ("configDetail".to_string(), config_detail.clone()),
                    ("search".to_string(), "blur".to_string()),
                    ("namespaceId".to_string(), namespace.to_string()),
                    ("pageNo".to_string(), page_no.to_string()),
                    ("pageSize".to_string(), page_size.to_string()),
                ],
            ),
            (
                "/v3/console/cs/config/searchDetail",
                vec![
                    ("configDetail".to_string(), config_detail),
                    ("search".to_string(), "blur".to_string()),
                    ("namespaceId".to_string(), namespace.to_string()),
                    ("pageNo".to_string(), page_no.to_string()),
                    ("pageSize".to_string(), page_size.to_string()),
                ],
            ),
        ];
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
            ("/v3/console/cs/config", v3_params.clone()),
            ("/v3/console/cs/config/detail", v3_params),
            ("/v1/cs/configs", v1_detail_params),
            ("/v1/cs/configs", v1_params),
        ] {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.request(reqwest::Method::GET, path, query, None, None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(resp) if path == "/v1/cs/configs" => {
                        let text =
                            resp.text().await.map_err(|e| format!("Failed to read Nacos config response: {e}"))?;
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            let detail = parse_config_detail(value, key.data_id, key.group, namespace);
                            return self.enrich_rnacos_config_metadata(detail).await;
                        }
                        let detail = NacosConfigItem {
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
                        };
                        return self.enrich_rnacos_config_metadata(detail).await;
                    }
                    Ok(resp) => {
                        let value = response_json_or_text(resp).await?;
                        let detail = parse_config_detail(value, key.data_id, key.group, namespace);
                        return self.enrich_rnacos_config_metadata(detail).await;
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
        for (path, form) in [
            ("/v3/console/cs/config", v3_form.clone()),
            ("/v3/console/cs/config/publish", v3_form.clone()),
            ("/v3/console/cs/config/update", v3_form),
        ] {
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
                ("/v3/console/cs/config", v3_query.clone()),
                ("/v3/console/cs/config/delete", v3_query.clone()),
                ("/v3/console/cs/config/remove", v3_query),
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
                    ("/v3/console/cs/history/list", v3_params.clone()),
                    ("/v3/console/cs/history", v3_params.clone()),
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
                    ("/v3/console/cs/history/detail", v3_params.clone()),
                    ("/v3/console/cs/history", v3_params.clone()),
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
        let mut v3_query = vec![
            ("dataId".to_string(), req.data_id.clone()),
            ("groupName".to_string(), req.group.clone()),
            ("namespaceId".to_string(), namespace.clone()),
            ("id".to_string(), req.history_id.clone()),
        ];
        if let Some(nid) = nid {
            v3_query.push(("nid".to_string(), nid.to_string()));
        }
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
        let endpoint_result = self
            .submit_query_candidates(
                "rollback Nacos config",
                reqwest::Method::POST,
                vec![
                    ("/v3/console/cs/history/rollback", v3_query.clone()),
                    ("/v3/console/cs/config/history/rollback", v3_query),
                    ("/v1/cs/history/rollback", v1_query.clone()),
                    ("/v1/cs/history/config/rollback", v1_query),
                ],
            )
            .await;
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
        let value = self
            .get_json_from_candidates(
                "list Nacos services",
                vec![
                    ("/v3/console/ns/service/list", v3_params.clone()),
                    ("/v1/ns/catalog/services", v1_catalog_params.clone()),
                    ("/v3/console/ns/service", v3_params),
                    ("/v1/ns/service/list", v1_legacy_params),
                ],
            )
            .await?;
        Ok(parse_service_list(value, page_no, page_size))
    }

    async fn list_instances(&self, query: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String> {
        let namespace = self.namespace(query.namespace.as_deref());
        let mut params = vec![
            ("serviceName".to_string(), query.service_name.clone()),
            ("namespaceId".to_string(), namespace.clone()),
        ];
        push_optional(&mut params, "groupName", query.group_name.clone());
        push_optional(&mut params, "clusters", query.clusters.clone());

        let mut errors = Vec::new();
        for path in ["/v3/console/ns/instance/list", "/v3/console/ns/instance"] {
            if !self.api_path_allowed(path) {
                continue;
            }
            match self.get_json(path, params.clone()).await {
                Ok(value) => return Ok(parse_instances(value)),
                Err(err) => errors.push(err),
            }
        }

        if self.api_path_allowed("/v1/ns/catalog/instances") {
            match self.list_v1_catalog_instances(&query, &namespace).await {
                Ok(instances) => return Ok(instances),
                Err(err) => errors.push(err),
            }
        }

        if !self.api_path_allowed("/v1/ns/instance/list") {
            return Err(format!("Failed to list Nacos instances: {}", errors.join("; ")));
        }
        match self.get_json("/v1/ns/instance/list", params).await {
            Ok(value) => Ok(parse_instances(value)),
            Err(err) => {
                errors.push(err);
                Err(format!("Failed to list Nacos instances: {}", errors.join("; ")))
            }
        }
    }

    async fn update_instance(&self, req: NacosInstanceUpdate) -> Result<(), String> {
        let namespace = self.namespace(req.namespace.as_deref());
        let mut form = vec![
            ("serviceName".to_string(), req.service_name),
            ("ip".to_string(), req.ip),
            ("port".to_string(), req.port.to_string()),
            ("namespaceId".to_string(), namespace),
        ];
        push_optional(&mut form, "groupName", req.group_name);
        push_optional(&mut form, "clusterName", req.cluster_name);
        if let Some(value) = req.healthy {
            form.push(("healthy".to_string(), value.to_string()));
        }
        if let Some(value) = req.enabled {
            form.push(("enabled".to_string(), value.to_string()));
        }
        if let Some(value) = req.ephemeral {
            form.push(("ephemeral".to_string(), value.to_string()));
        }
        if let Some(value) = req.weight {
            form.push(("weight".to_string(), value.to_string()));
        }
        if let Some(value) = req.metadata {
            form.push(("metadata".to_string(), value.to_string()));
        }
        self.submit_form_candidates(
            "update Nacos instance",
            reqwest::Method::PUT,
            vec![
                ("/v3/console/ns/instance", form.clone()),
                ("/v3/console/ns/instance/update", form.clone()),
                ("/v1/ns/instance", form),
            ],
        )
        .await
    }

    async fn get_dashboard(&self, query: NacosDashboardQuery) -> Result<NacosDashboardSnapshot, String> {
        let namespace = self.namespace(query.namespace.as_deref());
        let metrics_future = self.get_json_from_candidates(
            "load Nacos dashboard metrics",
            vec![
                ("/v3/admin/ns/ops/metrics", vec![("onlyStatus".to_string(), "false".to_string())]),
                ("/v2/ns/operator/metrics", vec![("onlyStatus".to_string(), "false".to_string())]),
                ("/v1/ns/operator/metrics", Vec::new()),
            ],
        );
        let nodes_future = self.get_dashboard_nodes();
        let namespaces_future = self.list_namespaces();
        let configs_future = self.list_configs(NacosConfigQuery {
            namespace: Some(namespace.clone()),
            group: None,
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
            Ok(value) => Some(parse_dashboard_metrics(value)),
            Err(error) => {
                warnings.push(self.dashboard_warning(error));
                None
            }
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
    let items = data
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
    if !namespaces.iter().any(|item| item.namespace.is_empty()) {
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
    if lower.contains("410 gone") && lower.contains("/v3/console/server/state") {
        return classified_error(
            "apiVersionMismatch",
            "Nacos v1 console API is disabled on this server. DBX already tried the v3 console state API first; please check that Server points to the Nacos console/admin URL and Context Path matches the console mount path.",
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
    if lower.contains("410 gone") || lower.contains("not found") || lower.contains("404") {
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
        content: optional_string_field(data, &["content", "value", "configValue", "config_value"])
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
            &["lastModifiedTime", "lastModifiedTs", "gmtModified", "modifiedTime", "opTime", "createdTime"],
        )
        .or_else(|| {
            optional_u64_field(
                &item,
                &["lastModifiedTime", "lastModifiedTs", "gmtModified", "modifiedTime", "opTime", "createdTime"],
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

fn parse_catalog_cluster_names(value: &Value) -> Vec<String> {
    let data = value.get("data").unwrap_or(value);
    let mut seen = HashSet::new();
    data.get("clusters")
        .or_else(|| value.get("clusters"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|cluster| optional_string_field(cluster, &["name", "clusterName"]))
        .filter(|name| seen.insert(name.clone()))
        .collect()
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
    data.get("hosts")
        .or_else(|| data.get("instances"))
        .or_else(|| data.get("list"))
        .or_else(|| data.get("pageItems"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("hosts"))
        .or_else(|| value.get("instances"))
        .or_else(|| value.get("list"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| NacosInstanceInfo {
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
        })
        .collect()
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

    async fn write_json_response(socket: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
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
            server_addr: server_addr.clone(),
            display_server_addr: server_addr,
            namespace: String::new(),
            context_path: String::new(),
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

    #[test]
    fn explicit_v3_rejects_legacy_admin_api_paths() {
        let mut config = test_admin_config("http://127.0.0.1:8848".to_string());
        config.version_mode = Some(NacosVersionMode::V3);
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        assert!(admin.api_path_allowed("/v3/admin/ns/ops/metrics"));
        assert!(admin.api_path_allowed("/health"));
        assert!(!admin.api_path_allowed("/v2/ns/operator/metrics"));
        assert!(!admin.api_path_allowed("/v1/ns/operator/metrics"));
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
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let warning =
            admin.dashboard_warning("NACOS_ERROR[contextPathMismatch]: No static resource v3/admin".to_string());
        assert!(warning.contains("http://host:8848/nacos"));
        assert!(warning.contains("not the port 8080 Console"));
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
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v3/console/cs/config/list?"));
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
    async fn v3_console_namespace_creation_uses_custom_namespace_id() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().next(), Some("POST"));
            assert_eq!(request.split_whitespace().nth(1), Some("/nacos/v3/console/core/namespace"));
            assert!(request.contains("customNamespaceId=team-dev"));
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
    async fn rnacos_namespace_creation_falls_back_to_nacos_compatible_v1_route() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/v3/console/core/namespace", "/v3/console/core/namespace/create"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                assert_eq!(request.split_whitespace().nth(1), Some(expected_path));
                write_not_found_response(&mut socket).await;
            }

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
    async fn version_mode_auto_falls_back_from_v3_to_v1_config_paths() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/nacos/v3/console/cs/config/list?"));
            write_not_found_response(&mut socket).await;

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
    async fn explicit_rnacos_falls_back_to_console_namespace_api() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/v1/console/namespaces");
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(request.split_whitespace().nth(1), Some("/rnacos/api/console/v2/namespaces/list"));
            assert!(request.to_ascii_lowercase().contains("token: console-token"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":[{"namespaceId":"prod","namespaceName":"production"}]}"#,
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

        let namespaces = admin.list_namespaces().await.unwrap();
        assert_eq!(namespaces[1].namespace, "prod");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_detail_enriches_raw_openapi_content_with_console_metadata() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/v3/console/cs/config", "/v3/console/cs/config/detail"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_text_response(&mut socket, "cloud_providers: {}\n").await;

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
            for expected_path in ["/v3/console/cs/config", "/v3/console/cs/config/detail"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_text_response(&mut socket, "cloud_providers: {}\n").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(!request.to_ascii_lowercase().contains("\ntoken:"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"configType":"YAML","desc":"anonymous console metadata"}}"#,
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
        assert_eq!(detail.config_type.as_deref(), Some("yaml"));
        assert_eq!(detail.desc.as_deref(), Some("anonymous console metadata"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rnacos_config_metadata_propagates_captcha_requirement_for_ui_retry() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in ["/v3/console/cs/config", "/v3/console/cs/config/detail"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_text_response(&mut socket, "cloud_providers: {}\n").await;

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
            assert!(read_request_target(&mut socket).await.starts_with("/v3/console/cs/config/list?"));
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_json_response(
                &mut socket,
                r#"{"totalCount":1,"pageItems":[{"dataId":"qilong-test","group":"qilong-test","tenant":"ops"}]}"#,
            )
            .await;

            for expected_path in ["/v3/console/cs/config", "/v3/console/cs/config/detail"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_text_response(&mut socket, "cloud_providers: {}\n").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"configType":"YAML","desc":"r-nacos description"}}"#,
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
            assert!(read_request_target(&mut socket).await.starts_with("/v3/console/cs/config/list?"));
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_json_response(
                &mut socket,
                r#"{"totalCount":1,"pageItems":[{"dataId":"application.yaml","group":"DEFAULT_GROUP","tenant":"ops"}]}"#,
            )
            .await;

            for expected_path in ["/v3/console/cs/config", "/v3/console/cs/config/detail"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert!(read_request_target(&mut socket).await.starts_with(expected_path));
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_request_target(&mut socket).await.starts_with("/v1/cs/configs?"));
            write_text_response(&mut socket, "server:\n  port: 8848\n").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.split_whitespace().nth(1).unwrap().starts_with("/rnacos/api/console/v2/config/info?"));
            assert!(!request.to_ascii_lowercase().contains("\ntoken:"));
            write_json_response(
                &mut socket,
                r#"{"success":true,"data":{"configType":"YAML","desc":"anonymous list description"}}"#,
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
            for expected_path in [
                "/nacos/health",
                "/nacos/v3/console/server/state",
                "/nacos/v1/ns/operator/servers",
                "/nacos/v1/console/server/state",
            ] {
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
    async fn explicit_nacos_v2_auth_failure_does_not_probe_rnacos() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/nacos/v1/auth/login");
            write_forbidden_response(&mut socket).await;
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
        assert!(error.contains("/v1/auth/login returned 403 Forbidden"));
        assert!(!error.contains("/rnacos/"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_rnacos_keeps_compatible_auth_fallback_with_proxy_context() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/gateway/nacos/v1/auth/login");
            write_not_found_response(&mut socket).await;

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
        assert!(!error.contains("/rnacos/v1/auth/user/login returned 404"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn uses_health_endpoint_when_console_state_apis_are_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in
                ["/nacos/v3/console/server/state", "/nacos/v1/ns/operator/servers", "/nacos/v1/console/server/state"]
            {
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
            for expected_path in
                ["/nacos/v3/console/server/state", "/nacos/v1/ns/operator/servers", "/nacos/v1/console/server/state"]
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_json_response(&mut socket, "success").await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/console/core/namespace/list");
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_json_response(&mut socket, r#"{"data":[]}"#).await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert!(!info.capabilities.supports_config_history);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn test_connection_accepts_client_openapi_when_console_state_and_health_are_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in
                ["/nacos/v3/console/server/state", "/nacos/v1/ns/operator/servers", "/nacos/v1/console/server/state"]
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                assert_eq!(read_request_target(&mut socket).await, expected_path);
                write_not_found_response(&mut socket).await;
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/health");
            write_service_unavailable_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v3/console/core/namespace/list");
            write_not_found_response(&mut socket).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_request_target(&mut socket).await, "/nacos/v1/console/namespaces");
            write_json_response(&mut socket, r#"{"data":[]}"#).await;
        });

        let mut config = test_admin_config(format!("http://{address}"));
        config.context_path = "/nacos".to_string();
        let admin = NacosOpenApiAdmin::new(config).unwrap();

        let info = admin.test_connection().await.unwrap();
        assert!(info.raw.is_none());
        assert_eq!(info.auth, "none");
        assert!(info.capabilities.supports_config_history);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_rnacos_console_for_config_history() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected_path in [
                "/nacos/v3/console/cs/history/list",
                "/nacos/v3/console/cs/history",
                "/nacos/v1/cs/history/list",
                "/nacos/v1/cs/history",
                "/nacos/v1/cs/history/configs",
            ] {
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
            for expected_path in [
                "/nacos/v3/console/cs/history/detail",
                "/nacos/v3/console/cs/history",
                "/nacos/v1/cs/history",
                "/nacos/v1/cs/history/config",
            ] {
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
            "NACOS_ERROR[authFailed]: Nacos admin /v3/console/core/namespace/list returned 403 Forbidden",
            "NACOS_ERROR[apiVersionMismatch]: Nacos admin /v1/console/namespaces returned 410 Gone",
        );
        assert!(err.starts_with("NACOS_ERROR[authFailed]:"));
        assert!(err.contains("/v3/console/core/namespace/list returned 403 Forbidden"));
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

        let admin = NacosOpenApiAdmin::new(test_admin_config(format!("http://{address}"))).unwrap();
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
                    "/v3/console/core/namespace/list" => {
                        r#"{"code":0,"data":{"pageItems":[{"namespaceId":"dev","namespaceName":"Development"}]}}"#
                    }
                    "/v3/console/cs/config/list" => r#"{"code":0,"data":{"totalCount":21,"pageItems":[]}}"#,
                    "/v3/console/ns/service/list" => r#"{"code":0,"data":{"count":3,"serviceList":[]}}"#,
                    "/actuator/prometheus" => {
                        "# TYPE system_cpu_usage gauge\nsystem_cpu_usage 0.25\n# TYPE nacos_monitor gauge\nnacos_monitor{module=\"config\",name=\"configCount\"} 12\nnacos_monitor{module=\"naming\",name=\"serviceCount\"} 4\nnacos_monitor{module=\"naming\",name=\"ipCount\"} 14\n"
                    }
                    path => panic!("unexpected dashboard request path: {path}"),
                };
                write_json_response(&mut socket, body).await;
            }
            paths
        });

        let admin = NacosOpenApiAdmin::new(test_admin_config(format!("http://{address}"))).unwrap();
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
        for path in ["/v1/cs/configs", "/v2/console/example", "/v3/console/server/state"] {
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
        assert_eq!(classify_nacos_error("No static resource nacos/v3/console/server/state"), "contextPathMismatch");
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
}
