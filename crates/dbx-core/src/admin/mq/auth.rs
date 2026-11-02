//! Authentication for message queue admin connections. Injects credentials
//! into outgoing `reqwest` requests, with token caching for OAuth2
//! client-credentials so we don't exchange a token on every call.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::util::truncate;

/// Authentication method for an MQ admin connection.
///
/// Sensitive fields (token / password / secret) are stored through the
/// project's encrypted connection-secrets / keychain path and are never logged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[derive(Default)]
pub enum MqAuth {
    #[default]
    None,
    /// Pulsar JWT bearer token.
    Token { token: String },
    /// HTTP Basic auth.
    Basic { username: String, password: String },
    /// Arbitrary API key header, e.g. `Authorization: <value>` or a custom header.
    ApiKey { header: String, value: String },
    /// OAuth2 client-credentials flow (Pulsar's `oauth2` auth plugin).
    OAuth2 {
        issuer_url: String,
        client_id: String,
        client_secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audience: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
}

/// Caches an OAuth2 access token with its expiry so repeated requests reuse it.
/// Also tracks in-flight token requests to prevent concurrent fetches.
#[derive(Debug, Default, Clone)]
pub struct TokenCache {
    inner: Arc<Mutex<TokenCacheState>>,
}

#[derive(Debug, Default)]
struct TokenCacheState {
    cached: Option<CachedToken>,
    /// Tracks whether a token fetch is currently in progress. Subsequent requests
    /// will wait on this shared future instead of issuing duplicate OAuth2 requests.
    #[allow(clippy::type_complexity)]
    in_flight: Option<Arc<tokio::sync::Notify>>,
}

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Refresh the cached token slightly before it actually expires.
const TOKEN_EXPIRY_SKEW: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct OAuth2TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

impl MqAuth {
    /// Apply this auth method to a request builder, fetching/refreshing an
    /// OAuth2 token through `http`/`cache` if necessary.
    pub async fn apply(
        &self,
        req: reqwest::RequestBuilder,
        http: &reqwest::Client,
        cache: &TokenCache,
    ) -> Result<reqwest::RequestBuilder, String> {
        match self {
            MqAuth::None => Ok(req),
            MqAuth::Token { token } => Ok(req.bearer_auth(token)),
            MqAuth::Basic { username, password } => Ok(req.basic_auth(username, Some(password))),
            MqAuth::ApiKey { header, value } => Ok(req.header(header.as_str(), value.as_str())),
            MqAuth::OAuth2 { .. } => {
                let token = self.fetch_oauth2_token(http, cache).await?;
                Ok(req.bearer_auth(token))
            }
        }
    }

    async fn fetch_oauth2_token(&self, http: &reqwest::Client, cache: &TokenCache) -> Result<String, String> {
        let MqAuth::OAuth2 { issuer_url, client_id, client_secret, audience, scope } = self else {
            return Err("not an OAuth2 auth method".to_string());
        };

        // Fast path: reuse a still-valid cached token.
        let notify = {
            let mut guard = cache.inner.lock().await;
            if let Some(cached) = &guard.cached {
                if cached.expires_at > Instant::now() {
                    return Ok(cached.token.clone());
                }
            }

            // Check if another task is already fetching a token
            if let Some(existing_notify) = &guard.in_flight {
                let notify = existing_notify.clone();
                drop(guard);
                // Wait for the in-flight request to complete
                notify.notified().await;
                // Re-check the cache after waiting
                let guard = cache.inner.lock().await;
                if let Some(cached) = &guard.cached {
                    if cached.expires_at > Instant::now() {
                        return Ok(cached.token.clone());
                    }
                }
                // Token still expired after waiting, we'll fetch ourselves
                return Err("Token fetch by another task failed or token still expired".to_string());
            }

            // Mark that we're now fetching
            let notify = Arc::new(tokio::sync::Notify::new());
            guard.in_flight = Some(notify.clone());
            notify
        };

        // Fetch the token (without holding the lock)
        let result = self.do_oauth2_token_fetch(http, issuer_url, client_id, client_secret, audience, scope).await;

        // Update cache and clear in-flight flag
        {
            let mut guard = cache.inner.lock().await;
            guard.in_flight = None;

            match result {
                Ok((token, ttl)) => {
                    let expires_at = Instant::now() + Duration::from_secs(ttl).saturating_sub(TOKEN_EXPIRY_SKEW);
                    guard.cached = Some(CachedToken { token: token.clone(), expires_at });
                    notify.notify_waiters();
                    Ok(token)
                }
                Err(e) => {
                    notify.notify_waiters();
                    Err(e)
                }
            }
        }
    }

    async fn do_oauth2_token_fetch(
        &self,
        http: &reqwest::Client,
        issuer_url: &str,
        client_id: &str,
        client_secret: &str,
        audience: &Option<String>,
        scope: &Option<String>,
    ) -> Result<(String, u64), String> {
        let mut form = vec![
            ("grant_type", "client_credentials".to_string()),
            ("client_id", client_id.to_string()),
            ("client_secret", client_secret.to_string()),
        ];
        if let Some(audience) = audience {
            form.push(("audience", audience.clone()));
        }
        if let Some(scope) = scope {
            form.push(("scope", scope.clone()));
        }

        let resp =
            http.post(issuer_url).form(&form).send().await.map_err(|e| format!("OAuth2 token request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let detail = oauth2_error_detail(&body).unwrap_or_else(|| truncate(&body, 300));
            return Err(format!("OAuth2 token endpoint returned {status}: {detail}"));
        }

        let parsed: OAuth2TokenResponse =
            resp.json().await.map_err(|e| format!("Failed to parse OAuth2 token response: {e}"))?;

        let ttl = parsed.expires_in.unwrap_or(3600);
        Ok((parsed.access_token, ttl))
    }
}

/// Extract a human-readable OAuth2 error detail from a JSON error response.
/// Returns `None` when the body is not a valid OAuth2 error payload.
fn oauth2_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?.as_str()?;
    let description = value.get("error_description").and_then(serde_json::Value::as_str);
    Some(match description {
        Some(desc) => format!("{error}: {desc}"),
        None => error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_default_is_none() {
        assert!(matches!(MqAuth::default(), MqAuth::None));
    }

    #[test]
    fn token_auth_serde_roundtrip() {
        let auth = MqAuth::Token { token: "abc".to_string() };
        let json = serde_json::to_string(&auth).expect("should serialize MqAuth");
        assert!(json.contains("\"kind\":\"token\""));
        let back: MqAuth = serde_json::from_str(&json).expect("should deserialize MqAuth");
        assert!(matches!(back, MqAuth::Token { token } if token == "abc"));
    }

    #[test]
    fn oauth2_optional_fields_skipped_when_absent() {
        let auth = MqAuth::OAuth2 {
            issuer_url: "https://issuer/token".to_string(),
            client_id: "id".to_string(),
            client_secret: "secret".to_string(),
            audience: None,
            scope: None,
        };
        let json = serde_json::to_string(&auth).expect("should serialize OAuth2 auth");
        assert!(!json.contains("audience"));
        assert!(!json.contains("scope"));
    }

    #[test]
    fn oauth2_error_detail_parses_standard_error() {
        let body = r#"{"error":"invalid_client","error_description":"Client authentication failed"}"#;
        assert_eq!(oauth2_error_detail(body).as_deref(), Some("invalid_client: Client authentication failed"));
    }

    #[test]
    fn oauth2_error_detail_returns_none_for_non_json() {
        assert!(oauth2_error_detail("not json").is_none());
    }
}
