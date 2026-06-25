use std::collections::HashMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::nacos::config::{NacosAdminConfig, NacosAuthConfig};
use crate::nacos::port::NacosAdmin;
use crate::nacos::types::*;

const REQUEST_TIMEOUT_SECS: u64 = 30;
const MAX_RAW_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const NACOS_ERROR_PREFIX: &str = "NACOS_ERROR";

#[derive(Debug, Clone)]
struct AccessToken {
    token: String,
    expires_at: Instant,
}

pub struct NacosOpenApiAdmin {
    cfg: NacosAdminConfig,
    http: reqwest::Client,
    token: Mutex<Option<AccessToken>>,
}

impl NacosOpenApiAdmin {
    pub fn new(cfg: NacosAdminConfig) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
        if cfg.tls_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if let Some(connect_override) = cfg.connect_override.as_ref() {
            let url =
                reqwest::Url::parse(&cfg.server_addr).map_err(|e| format!("Nacos server address is invalid: {e}"))?;
            let host = url.host_str().ok_or("Nacos server address host is empty")?;
            let _port = url.port_or_known_default().ok_or("Nacos server address port is empty")?;
            builder = builder.resolve(
                host,
                std::net::SocketAddr::new(
                    connect_override
                        .host
                        .parse()
                        .map_err(|e| format!("Nacos transport override host must be an IP address: {e}"))?,
                    connect_override.port,
                ),
            );
        }
        let http = builder.build().map_err(|e| format!("Failed to build Nacos HTTP client: {e}"))?;
        Ok(Self { cfg, http, token: Mutex::new(None) })
    }

    fn endpoint_with_context(&self, path: &str, context_path: &str) -> Result<String, String> {
        let path = normalize_api_path(path);
        let context_path = normalize_api_path(context_path).trim_end_matches('/').to_string();
        let base = format!("{}{}", self.cfg.server_addr, context_path);
        let base = base.trim_end_matches('/');
        let full = if path.starts_with("/nacos/") && context_path == "/nacos" {
            format!("{}{}", self.cfg.server_addr, path)
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
        let mut last_err = None;
        let mut resp = None;
        for path in ["/v1/auth/login", "/v3/auth/user/login"] {
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
                    Err(err) => last_err = Some(err),
                },
                Err(err) => last_err = Some(err),
            }
        }
        let resp = resp.ok_or_else(|| last_err.unwrap_or_else(|| "Nacos auth request failed".to_string()))?;
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

    async fn get_server_state(&self) -> Result<Value, String> {
        let mut errors = Vec::new();
        for path in ["/v3/console/server/state", "/v1/ns/operator/servers", "/v1/console/server/state"] {
            match self.get_json_without_auth(path, Vec::new()).await {
                Ok(value) => return Ok(value),
                Err(err) => errors.push(err),
            }
        }
        Err(admin_endpoint_error(&self.cfg.server_addr, &errors))
    }

    fn namespace(&self, override_ns: Option<&str>) -> String {
        override_ns.unwrap_or(&self.cfg.namespace).trim().to_string()
    }

    async fn get_config_list_value(
        &self,
        namespace: &str,
        search: &str,
        group: &str,
        page_no: u32,
        page_size: u32,
    ) -> Result<Value, String> {
        let v3_params = vec![
            ("search".to_string(), "blur".to_string()),
            ("dataId".to_string(), search.to_string()),
            ("groupName".to_string(), group.to_string()),
            ("namespaceId".to_string(), namespace.to_string()),
            ("pageNo".to_string(), page_no.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ];
        match self.get_json("/v3/console/cs/config/list", v3_params).await {
            Ok(value) => Ok(value),
            Err(v3_err) => {
                let v1_params = vec![
                    ("search".to_string(), "blur".to_string()),
                    ("dataId".to_string(), search.to_string()),
                    ("group".to_string(), group.to_string()),
                    ("tenant".to_string(), namespace.to_string()),
                    ("pageNo".to_string(), page_no.to_string()),
                    ("pageSize".to_string(), page_size.to_string()),
                ];
                self.get_json("/v1/cs/configs", v1_params).await.map_err(|v1_err| {
                    format!("Failed to list Nacos configs with v3 and v1 APIs. v3: {v3_err}; v1: {v1_err}")
                })
            }
        }
    }

    async fn get_json_from_candidates(
        &self,
        operation: &str,
        attempts: Vec<(&str, Vec<(String, String)>)>,
    ) -> Result<Value, String> {
        let mut errors = Vec::new();
        for (path, query) in attempts {
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
        page_no: u32,
        page_size: u32,
    ) -> Result<NacosConfigList, String> {
        let Some(filter) = data_id_filter.map(|value| value.to_lowercase()).filter(|value| !value.is_empty()) else {
            return Ok(NacosConfigList { page_no, page_size, total_count: 0, items: Vec::new() });
        };
        let group = group.unwrap_or_default();
        let scan_page_size = page_size.max(self.cfg.page_size).clamp(100, 500);
        let max_scan_pages = 10;
        let mut matched = Vec::new();
        let mut current_page = 1;

        while current_page <= max_scan_pages {
            let value = self.get_config_list_value(&namespace, "", &group, current_page, scan_page_size).await?;
            let list = parse_config_list(value, namespace.clone(), current_page, scan_page_size);
            matched.extend(list.items.into_iter().filter(|item| item.data_id.to_lowercase().contains(&filter)));

            let scanned = u64::from(current_page) * u64::from(scan_page_size);
            if scanned >= list.total_count || list.total_count == 0 {
                break;
            }
            current_page += 1;
        }

        let total_count = matched.len() as u64;
        let start = ((page_no.saturating_sub(1)) * page_size) as usize;
        let end = start.saturating_add(page_size as usize).min(matched.len());
        let items = if start < matched.len() { matched[start..end].to_vec() } else { Vec::new() };
        Ok(self.enrich_missing_config_formats(NacosConfigList { page_no, page_size, total_count, items }).await)
    }

    async fn enrich_missing_config_formats(&self, mut list: NacosConfigList) -> NacosConfigList {
        for item in list.items.iter_mut() {
            if item.config_type.is_some() {
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
                item.config_type = detail.config_type;
            }
        }
        list
    }
}

#[async_trait]
impl NacosAdmin for NacosOpenApiAdmin {
    async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
        let raw = self.get_server_state().await?;
        let _ = self.access_token().await?;
        Ok(NacosConnectionInfo {
            server_addr: self.cfg.server_addr.clone(),
            namespace: self.cfg.namespace.clone(),
            server_version: extract_server_version(&raw),
            auth: match self.cfg.auth {
                NacosAuthConfig::None => "none".to_string(),
                NacosAuthConfig::UsernamePassword { .. } => "usernamePassword".to_string(),
            },
            capabilities: NacosCapabilities::default(),
            raw: Some(raw),
        })
    }

    async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
        let value = match self.get_json("/v3/console/core/namespace/list", Vec::new()).await {
            Ok(value) => value,
            Err(_) => self.get_json("/v1/console/namespaces", Vec::new()).await?,
        };
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
        let value = self.get_config_list_value(&namespace, &search, &group, page_no, page_size).await?;
        let parsed =
            self.enrich_missing_config_formats(parse_config_list(value, namespace.clone(), page_no, page_size)).await;
        if data_id_filter.is_some() && parsed.items.is_empty() {
            let fallback =
                self.list_configs_by_client_filter(namespace, group_filter, data_id_filter, page_no, page_size).await?;
            if !fallback.items.is_empty() {
                return Ok(fallback);
            }
        }
        Ok(parsed)
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
            match self.request(reqwest::Method::GET, path, query, None, None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(resp) if path == "/v1/cs/configs" => {
                        let text =
                            resp.text().await.map_err(|e| format!("Failed to read Nacos config response: {e}"))?;
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            return Ok(parse_config_detail(value, key.data_id, key.group, namespace));
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
        let mut v3_query = vec![
            ("dataId".to_string(), req.data_id.clone()),
            ("groupName".to_string(), req.group.clone()),
            ("content".to_string(), req.content.clone()),
            ("namespaceId".to_string(), namespace.clone()),
        ];
        push_optional(&mut v3_query, "type", req.config_type.clone());
        push_optional(&mut v3_query, "appName", req.app_name.clone());
        push_optional(&mut v3_query, "desc", req.desc.clone());
        push_optional(&mut v3_query, "tags", req.tags.clone());

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

        let mut errors = Vec::new();
        for (path, query) in [
            ("/v3/console/cs/config", v3_query.clone()),
            ("/v3/console/cs/config/publish", v3_query.clone()),
            ("/v3/console/cs/config/update", v3_query),
        ] {
            match self.request(reqwest::Method::POST, path, query, None, None).await {
                Ok(resp) => match error_for_status(resp, path).await {
                    Ok(_) => return Ok(()),
                    Err(err) => errors.push(err),
                },
                Err(err) => errors.push(err),
            }
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
        let value = self
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
            .map_err(|err| classified_error("unsupportedConfigHistory", &err))?;
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
        let value = self
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
            .map_err(|err| classified_error("unsupportedConfigHistory", &err))?;
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
        let mut params = vec![("serviceName".to_string(), query.service_name), ("namespaceId".to_string(), namespace)];
        push_optional(&mut params, "groupName", query.group_name);
        push_optional(&mut params, "clusters", query.clusters);
        let value = self
            .get_json_from_candidates(
                "list Nacos instances",
                vec![
                    ("/v3/console/ns/instance/list", params.clone()),
                    ("/v3/console/ns/instance", params.clone()),
                    ("/v1/ns/instance/list", params),
                ],
            )
            .await?;
        Ok(parse_instances(value))
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
                "Nacos admin endpoint was not found at {server_addr}. This looks like a Nacos client/server port, not the console/admin API address. Use the console URL, for example http://127.0.0.1:8085 in Nacos 3 Docker deployments, and leave Context Path empty unless the console is actually mounted under /nacos."
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
    let message = format!("Nacos admin {path} returned {status}: {}", detail.trim());
    Err(classified_error(classify_nacos_error(&message), &message))
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
    if lower.contains("no static resource")
        || lower.contains("context path")
        || lower.contains("path\":\"/")
        || lower.contains("path=/")
    {
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
            desc: optional_string_field(&item, &["desc", "description"]),
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
        desc: optional_string_field(data, &["desc", "description"]),
        tags: optional_string_field(data, &["tags", "configTags", "config_tags"]),
        config_type: config_format_for_item(data).or_else(|| infer_config_format(&data_id)),
        md5: optional_string_field(data, &["md5"]),
        encrypted_data_key: optional_string_field(data, &["encryptedDataKey"]),
        content: optional_string_field(data, &["content"]).or_else(|| value.as_str().map(str::to_string)),
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
        operator: optional_string_field(&item, &["operator", "srcUser", "createUser", "modifyUser", "user"]),
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

fn parse_instances(value: Value) -> Vec<NacosInstanceInfo> {
    let data = value.get("data").unwrap_or(&value);
    data.get("hosts")
        .or_else(|| data.get("instances"))
        .or_else(|| data.get("pageItems"))
        .or_else(|| data.get("items"))
        .or_else(|| value.get("hosts"))
        .or_else(|| value.get("instances"))
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
    keys.iter().find_map(|key| value.get(*key)).and_then(Value::as_u64)
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

    #[test]
    fn parses_config_list_shapes() {
        let parsed = parse_config_list(
            serde_json::json!({
                "totalCount": 1,
                "pageItems": [{ "dataId": "app.yaml", "group": "DEFAULT_GROUP", "type": "yaml" }]
            }),
            "public".to_string(),
            1,
            20,
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].data_id, "app.yaml");
        assert_eq!(parsed.items[0].namespace, "public");
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
                        { "dataId": "app.json", "groupName": "DEFAULT_GROUP", "namespaceId": "public" }
                    ]
                }
            }),
            "public".to_string(),
            1,
            20,
        );
        assert_eq!(parsed.total_count, 1);
        assert_eq!(parsed.items[0].group, "DEFAULT_GROUP");
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
        assert_eq!(classify_nacos_error("404 Not Found"), "apiVersionMismatch");
        assert_eq!(classify_nacos_error("connection refused"), "connectionFailed");
    }
}
