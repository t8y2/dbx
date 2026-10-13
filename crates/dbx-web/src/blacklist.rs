//! 登录黑名单内存缓存与 IP 屏蔽中间件。
//!
//! [`BlacklistCache`] 启动时从 SQLite `login_blacklist` 表加载，进程内以
//! `HashSet` 提供零查询开销的判定；T5 管理端变更黑名单后调用
//! [`BlacklistCache::reload`]（或先 [`BlacklistCache::invalidate`] 再加载）刷新。
//!
//! [`ip_blacklist_middleware`] 挂在整条中间件链最外层（`migration_gate` 之前，
//! 且覆盖静态资源与 MCP 端点），命中即返回 `403 {"error":"ip_blacklisted"}`。

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dbx_core::persistence::access_control::{BlacklistEntry, BLACKLIST_KIND_IP, BLACKLIST_KIND_USER};
use dbx_core::storage::Storage;

use crate::state::WebState;

/// 登录黑名单内存缓存（IP + 用户名两类）。
#[derive(Default)]
pub struct BlacklistCache {
    ips: RwLock<HashSet<String>>,
    users: RwLock<HashSet<String>>,
}

impl BlacklistCache {
    pub fn empty() -> Self {
        Self::default()
    }

    /// 启动时从 SQLite 加载全量黑名单。
    pub async fn load(storage: &Storage) -> Result<Self, String> {
        let entries = storage.list_blacklist().await?;
        Ok(Self::from_entries(&entries))
    }

    fn from_entries(entries: &[BlacklistEntry]) -> Self {
        let cache = Self::empty();
        cache.absorb(entries);
        cache
    }

    fn absorb(&self, entries: &[BlacklistEntry]) {
        let mut ips = self.ips.write().unwrap_or_else(|error| error.into_inner());
        let mut users = self.users.write().unwrap_or_else(|error| error.into_inner());
        for entry in entries {
            match entry.kind.as_str() {
                BLACKLIST_KIND_IP => {
                    ips.insert(entry.value.clone());
                }
                BLACKLIST_KIND_USER => {
                    users.insert(entry.value.clone());
                }
                other => {
                    log::warn!("Ignoring unknown login_blacklist kind: {other}");
                }
            }
        }
    }

    pub fn is_ip_blacklisted(&self, ip: &str) -> bool {
        let ips = self.ips.read().unwrap_or_else(|error| error.into_inner());
        ips.contains(ip)
    }

    pub fn is_user_blacklisted(&self, username: &str) -> bool {
        let users = self.users.read().unwrap_or_else(|error| error.into_inner());
        users.contains(username)
    }

    /// 清空内存缓存（与 [`Self::reload`] 配合，或测试隔离用）。
    pub fn invalidate(&self) {
        self.ips.write().unwrap_or_else(|error| error.into_inner()).clear();
        self.users.write().unwrap_or_else(|error| error.into_inner()).clear();
    }

    /// 从 SQLite 重新加载（T5 黑名单变更后调用）。
    pub async fn reload(&self, storage: &Storage) -> Result<(), String> {
        let entries = storage.list_blacklist().await?;
        self.invalidate();
        self.absorb(&entries);
        Ok(())
    }
}

/// 解析客户端 IP：`DBX_TRUST_PROXY=1` 时优先取 `X-Forwarded-For` 首值，
/// 否则使用 socket 对端地址（`ConnectInfo` 缺失时为 `"unknown"`）。
pub fn client_ip(headers: &HeaderMap, addr: &SocketAddr, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()) {
            if let Some(first) = forwarded.split(',').next() {
                let first = first.trim();
                if !first.is_empty() {
                    return first.to_string();
                }
            }
        }
    }
    addr.ip().to_string()
}

/// 从请求扩展中解析 [`client_ip`]（中间件内使用，不依赖 `ConnectInfo` 提取器）。
pub fn client_ip_from_request<B>(req: &Request<B>, trust_proxy: bool) -> String {
    let addr = req
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|info| info.0)
        .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0)));
    client_ip(req.headers(), &addr, trust_proxy)
}

/// IP 黑名单中间件：对全部请求（含静态资源与 MCP）生效，挂在最外层。
pub async fn ip_blacklist_middleware(
    State(state): State<Arc<WebState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let ip = client_ip_from_request(&req, state.trust_proxy);
    if state.blacklist.is_ip_blacklisted(&ip) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "ip_blacklisted"}))).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, value: &str) -> BlacklistEntry {
        BlacklistEntry {
            id: 1,
            kind: kind.to_string(),
            value: value.to_string(),
            reason: None,
            created_by: None,
            created_at: 0,
        }
    }

    #[test]
    fn cache_separates_ip_and_user_kinds() {
        let cache = BlacklistCache::from_entries(&[
            entry(BLACKLIST_KIND_IP, "10.0.0.9"),
            entry(BLACKLIST_KIND_USER, "mallory"),
        ]);
        assert!(cache.is_ip_blacklisted("10.0.0.9"));
        assert!(!cache.is_ip_blacklisted("10.0.0.10"));
        assert!(cache.is_user_blacklisted("mallory"));
        assert!(!cache.is_user_blacklisted("10.0.0.9"));

        cache.invalidate();
        assert!(!cache.is_ip_blacklisted("10.0.0.9"));
        assert!(!cache.is_user_blacklisted("mallory"));
    }

    #[test]
    fn unknown_kinds_are_ignored() {
        let cache = BlacklistCache::from_entries(&[entry("domain", "example.com")]);
        assert!(!cache.is_ip_blacklisted("example.com"));
        assert!(!cache.is_user_blacklisted("example.com"));
    }

    #[test]
    fn client_ip_prefers_forwarded_for_only_when_trusting_proxy() {
        let addr: SocketAddr = "127.0.0.1:44444".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());

        assert_eq!(client_ip(&headers, &addr, true), "203.0.113.7");
        assert_eq!(client_ip(&headers, &addr, false), "127.0.0.1");

        let empty = HeaderMap::new();
        assert_eq!(client_ip(&empty, &addr, true), "127.0.0.1");

        let mut blank = HeaderMap::new();
        blank.insert("x-forwarded-for", "  ".parse().unwrap());
        assert_eq!(client_ip(&blank, &addr, true), "127.0.0.1");
    }
}
