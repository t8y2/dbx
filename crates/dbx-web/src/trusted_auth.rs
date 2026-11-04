use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::{body::Body, http::Request, Json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{auth, state::WebState};

pub async fn check(state: State<Arc<WebState>>, req: Request<Body>) -> Json<auth::AuthCheckResponse> {
    let trusted = state.0.trusted_header_auth.as_ref().is_some_and(|auth| auth.matches(req.headers()));
    let Json(mut response) = auth::check(state, req).await;
    if !response.authenticated && trusted {
        response.authenticated = true;
        response.required = false;
        response.setup_required = false;
    }
    Json(response)
}

pub struct TrustedHeaderAuth {
    header: HeaderName,
    token_digest: [u8; 32],
}

impl TrustedHeaderAuth {
    pub fn from_values(
        enabled: Option<&str>,
        header: Option<&str>,
        token: Option<&str>,
    ) -> Result<Option<Self>, String> {
        let enabled = match enabled.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            None | Some("") | Some("0" | "false" | "no" | "off") => false,
            Some("1" | "true" | "yes" | "on") => true,
            Some(_) => return Err("DBX_WEB_TRUSTED_AUTH_ENABLED must be a boolean".to_string()),
        };
        if !enabled {
            return Ok(None);
        }

        let header = header.map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| {
            "DBX_WEB_TRUSTED_AUTH_HEADER is required when trusted Header authentication is enabled".to_string()
        })?;
        let header = HeaderName::from_bytes(header.as_bytes())
            .map_err(|_| "DBX_WEB_TRUSTED_AUTH_HEADER is not a valid HTTP header name".to_string())?;
        if header == axum::http::header::COOKIE {
            return Err("DBX_WEB_TRUSTED_AUTH_HEADER must not use the session Cookie header".to_string());
        }
        let token = token.filter(|value| !value.trim().is_empty()).ok_or_else(|| {
            "DBX_WEB_TRUSTED_AUTH_TOKEN is required when trusted Header authentication is enabled".to_string()
        })?;
        let token = HeaderValue::from_str(token)
            .map_err(|_| "DBX_WEB_TRUSTED_AUTH_TOKEN is not a valid HTTP header value".to_string())?;

        Ok(Some(Self { header, token_digest: Sha256::digest(token.as_bytes()).into() }))
    }

    pub fn header_name(&self) -> &HeaderName {
        &self.header
    }

    pub fn matches(&self, headers: &HeaderMap) -> bool {
        let mut values = headers.get_all(&self.header).iter();
        let Some(value) = values.next() else {
            return false;
        };
        if values.next().is_some() {
            return false;
        }
        let candidate: [u8; 32] = Sha256::digest(value.as_bytes()).into();
        bool::from(self.token_digest.ct_eq(&candidate))
    }
}

#[cfg(test)]
mod tests {
    use super::TrustedHeaderAuth;

    #[test]
    fn trusted_header_auth_parses_and_matches_exact_values() {
        assert!(TrustedHeaderAuth::from_values(None, None, None).unwrap().is_none());
        assert!(TrustedHeaderAuth::from_values(Some("off"), Some("bad header"), None).unwrap().is_none());
        assert!(TrustedHeaderAuth::from_values(Some("maybe"), None, None).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), None, Some("secret")).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), Some("bad header"), Some("secret")).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), Some("X-Auth"), None).is_err());
        assert!(TrustedHeaderAuth::from_values(Some("true"), Some("Cookie"), Some("secret")).is_err());
        for token in ["", "   ", "secret\n"] {
            assert!(TrustedHeaderAuth::from_values(Some("true"), Some("X-Auth"), Some(token)).is_err());
        }

        let auth = TrustedHeaderAuth::from_values(Some("yes"), Some("X-Auth"), Some("secret")).unwrap().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        assert!(!auth.matches(&headers));
        headers.insert("x-auth", "secret".parse().unwrap());
        assert!(auth.matches(&headers));
        headers.insert("x-auth", "wrong".parse().unwrap());
        assert!(!auth.matches(&headers));
        headers.insert("x-auth", "Secret".parse().unwrap());
        assert!(!auth.matches(&headers));
        headers.insert("x-auth", "secret".parse().unwrap());
        headers.append("x-auth", "secret".parse().unwrap());
        assert!(!auth.matches(&headers));
    }
}
