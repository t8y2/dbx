//! Reverse-proxy header authentication (oauth2-proxy / Authelia / nginx auth_request deployments).
//!
//! The proxy authenticates and injects `X-Forwarded-User` style headers; this provider
//! only trusts direct peers inside the `trusted_proxies` CIDRs and treats every other
//! source as anonymous (the dbx-web middleware also strips these headers as defense in depth).
//! For 5 minutes after logout the same user is not auto-logged-in again by the proxy SSO.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use http::HeaderMap;
use serde::{Deserialize, Serialize};

use crate::identity::{map_role, AuthIdentity, UserRole};
use crate::provider::{AuthProvider, AuthProviderKind, LoginMode};

/// Logout grace period: the user is not auto-logged-in again during this window.
const LOGOUT_GRACE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProxyHeaderConfig {
    /// User identity header name (default `X-Forwarded-User`).
    #[serde(default = "default_user_header")]
    pub user_header: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name_header: Option<String>,
    /// Groups header name (comma-separated group list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups_header: Option<String>,
    /// Trusted proxy CIDR list (e.g. `["10.0.0.0/8", "::1/128"]`).
    #[serde(default = "default_trusted_proxies")]
    pub trusted_proxies: Vec<String>,
    /// Group → DBX role mapping.
    #[serde(default)]
    pub role_map: HashMap<String, String>,
    #[serde(default)]
    pub default_role: Option<UserRole>,
}

fn default_user_header() -> String {
    "X-Forwarded-User".to_string()
}

fn default_trusted_proxies() -> Vec<String> {
    vec!["127.0.0.0/8".to_string(), "::1/128".to_string()]
}

impl Default for ProxyHeaderConfig {
    fn default() -> Self {
        Self {
            user_header: default_user_header(),
            email_header: None,
            display_name_header: None,
            groups_header: None,
            trusted_proxies: vec!["127.0.0.0/8".to_string(), "::1/128".to_string()],
            role_map: HashMap::new(),
            default_role: None,
        }
    }
}

impl ProxyHeaderConfig {
    /// All identity header names present in the config (used when the middleware strips headers from untrusted sources).
    pub fn identity_header_names(&self) -> Vec<String> {
        let mut names = vec![self.user_header.clone()];
        for header in [self.email_header.as_ref(), self.display_name_header.as_ref(), self.groups_header.as_ref()].into_iter().flatten() {
            names.push(header.clone());
        }
        names
    }
}

/// CIDR matching (IPv4/IPv6; an out-of-range prefix length counts as invalid config).
fn ip_in_cidr(ip: IpAddr, cidr: &str) -> bool {
    let Some((network, prefix)) = cidr.split_once('/') else {
        return ip.to_string() == cidr.trim();
    };
    let Ok(prefix) = prefix.parse::<u8>() else { return false };
    match (ip, network.trim().parse::<IpAddr>()) {
        (IpAddr::V4(ip), Ok(IpAddr::V4(net))) => prefix <= 32 && in_subnet_v4(ip, net, prefix),
        (IpAddr::V6(ip), Ok(IpAddr::V6(net))) => prefix <= 128 && in_subnet_v6(ip, net, prefix),
        // Normalize IPv4-mapped IPv6 down to v4 for comparison (::ffff:10.0.0.1 etc.).
        (IpAddr::V6(ip), Ok(IpAddr::V4(net))) if matches!(ip.to_ipv4_mapped(), Some(_)) => {
            let ip = ip.to_ipv4_mapped().unwrap();
            prefix <= 32 && in_subnet_v4(ip, net, prefix)
        }
        _ => false,
    }
}

fn in_subnet_v4(ip: Ipv4Addr, net: Ipv4Addr, prefix: u8) -> bool {
    let ip_u32 = u32::from(ip);
    let net_u32 = u32::from(net);
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    ip_u32 & mask == net_u32 & mask
}

fn in_subnet_v6(ip: Ipv6Addr, net: Ipv6Addr, prefix: u8) -> bool {
    let ip_u128 = u128::from(ip);
    let net_u128 = u128::from(net);
    let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
    ip_u128 & mask == net_u128 & mask
}

/// Proxy-header auth provider.
pub struct ProxyHeaderProvider {
    id: String,
    config: ProxyHeaderConfig,
    label: String,
    /// Logout grace records (username → logout instant).
    logout_grace: Mutex<HashMap<String, Instant>>,
}

impl ProxyHeaderProvider {
    pub fn new(config: ProxyHeaderConfig) -> Self {
        Self { id: "proxy".to_string(), config, label: "Proxy".to_string(), logout_grace: Mutex::new(HashMap::new()) }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    fn from_trusted_proxy(&self, client_ip: IpAddr) -> bool {
        self.config.trusted_proxies.iter().any(|cidr| ip_in_cidr(client_ip, cidr))
    }

    /// Records a logout grace entry (called by the logout handler for proxy-sourced sessions).
    pub async fn record_logout(&self, username: &str) {
        self.logout_grace.lock().expect("proxy logout grace lock").insert(username.to_string(), Instant::now());
    }

    async fn in_logout_grace(&self, username: &str) -> bool {
        let mut grace = self.logout_grace.lock().expect("proxy logout grace lock");
        grace.retain(|_, at| at.elapsed() < LOGOUT_GRACE);
        grace.contains_key(username)
    }

    /// Identity headers the middleware strips from untrusted sources (per this provider's config).
    pub fn untrusted_identity_headers(&self) -> Vec<String> {
        self.config.identity_header_names()
    }
}

#[async_trait]
impl AuthProvider for ProxyHeaderProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> AuthProviderKind {
        AuthProviderKind::ProxyHeader
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn login_mode(&self) -> LoginMode {
        LoginMode::Proxy
    }

    async fn on_logout(&self, username: &str) {
        self.record_logout(username).await;
    }

    async fn authenticate_proxy(&self, client_ip: IpAddr, headers: &HeaderMap) -> Option<AuthIdentity> {
        if !self.from_trusted_proxy(client_ip) {
            return None;
        }
        let username = headers.get(&self.config.user_header)?.to_str().ok()?.trim().to_string();
        if username.is_empty() || self.in_logout_grace(&username).await {
            return None;
        }
        let email = self
            .config
            .email_header
            .as_ref()
            .and_then(|header| headers.get(header))
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let display_name = self
            .config
            .display_name_header
            .as_ref()
            .and_then(|header| headers.get(header))
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let groups = self
            .config
            .groups_header
            .as_ref()
            .and_then(|header| headers.get(header))
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(',').map(str::trim).filter(|part| !part.is_empty()).map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        let role = map_role(&groups, &self.config.role_map, self.config.default_role.unwrap_or(UserRole::Member));
        Some(AuthIdentity {
            provider_id: self.id.clone(),
            subject: username.clone(),
            username,
            display_name,
            email,
            groups,
            role,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn provider(trusted: &[&str]) -> ProxyHeaderProvider {
        let mut config = ProxyHeaderConfig::default();
        config.trusted_proxies = trusted.iter().map(|value| value.to_string()).collect();
        config.groups_header = Some("X-Forwarded-Groups".to_string());
        config.default_role = Some(UserRole::Member);
        let mut provider = ProxyHeaderProvider::new(config);
        provider.id = "proxy".into();
        provider
    }

    fn headers(user: &str, groups: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-user", user.parse().unwrap());
        headers.insert("x-forwarded-groups", groups.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn trusts_only_configured_cidrs() {
        let provider = provider(&["10.0.0.0/8"]);
        assert!(provider.authenticate_proxy("10.1.2.3".parse().unwrap(), &headers("alice", "ops")).await.is_some());
        assert!(provider.authenticate_proxy("11.1.2.3".parse().unwrap(), &headers("alice", "ops")).await.is_none());
        assert!(provider.authenticate_proxy("127.0.0.1".parse().unwrap(), &headers("alice", "ops")).await.is_none());
    }

    #[tokio::test]
    async fn maps_groups_to_roles_and_defaults() {
        let mut config = ProxyHeaderConfig::default();
        config.trusted_proxies = vec!["127.0.0.0/8".to_string()];
        config.groups_header = Some("X-Forwarded-Groups".to_string());
        config.role_map = HashMap::from([("ops-admin".to_string(), "admin".to_string())]);
        let mut provider = ProxyHeaderProvider::new(config);
        provider.id = "proxy".into();

        let identity = provider.authenticate_proxy("127.0.0.1".parse().unwrap(), &headers("bob", "ops-admin,ops-viewer")).await.unwrap();
        assert_eq!(identity.role, UserRole::Admin);
        assert_eq!(identity.groups, vec!["ops-admin".to_string(), "ops-viewer".to_string()]);

        let identity = provider.authenticate_proxy("127.0.0.1".parse().unwrap(), &headers("carol", "")).await.unwrap();
        assert_eq!(identity.role, UserRole::Member);
        assert_eq!(identity.subject, "carol");
    }

    #[tokio::test]
    async fn logout_grace_blocks_auto_relogin() {
        let provider = provider(&["127.0.0.0/8"]);
        assert!(provider.authenticate_proxy("127.0.0.1".parse().unwrap(), &headers("dave", "")).await.is_some());
        provider.record_logout("dave").await;
        assert!(provider.authenticate_proxy("127.0.0.1".parse().unwrap(), &headers("dave", "")).await.is_none());
        // Other users are unaffected.
        assert!(provider.authenticate_proxy("127.0.0.1".parse().unwrap(), &headers("erin", "")).await.is_some());
    }

    #[test]
    fn cidr_matching_covers_v4_v6_and_mapped() {
        assert!(ip_in_cidr("192.168.1.5".parse().unwrap(), "192.168.0.0/16"));
        assert!(!ip_in_cidr("192.169.1.5".parse().unwrap(), "192.168.0.0/16"));
        assert!(ip_in_cidr("10.0.0.1".parse().unwrap(), "10.0.0.1"));
        assert!(ip_in_cidr("::1".parse().unwrap(), "::1/128"));
        assert!(!ip_in_cidr("::2".parse().unwrap(), "::1/128"));
        assert!(ip_in_cidr("::ffff:10.0.0.1".parse().unwrap(), "10.0.0.0/8"));
        assert!(!ip_in_cidr("10.0.0.1".parse().unwrap(), "not-a-cidr/99"));
    }
}
