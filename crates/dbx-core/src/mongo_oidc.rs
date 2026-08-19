use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures::FutureExt;
use mongodb::{
    error::Error as MongoError,
    options::oidc::{Callback, CallbackContext, IdpServerResponse},
};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};

pub const OIDC_REDIRECT_URI: &str = "http://localhost:27097/redirect";
const OIDC_CALLBACK_ADDRESS: &str = "127.0.0.1:27097";
const DEFAULT_CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const OIDC_BROWSER_AUTH_TIMEOUT: Duration = DEFAULT_CALLBACK_TIMEOUT;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;

pub type MongoOidcBrowserOpener = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

#[derive(Debug, Deserialize)]
struct OidcDiscoveryDocument {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct OidcTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug)]
struct AuthorizationCallback {
    code: String,
    state: String,
}

fn browser_flow_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn oidc_error(message: impl Into<String>) -> MongoError {
    MongoError::custom(format!("MongoDB OIDC authentication failed: {}", message.into()))
}

fn discovery_url(issuer: &str) -> Result<Url, MongoError> {
    let mut url = Url::parse(issuer).map_err(|err| oidc_error(format!("invalid issuer URL: {err}")))?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(oidc_error("issuer URL must not contain a query or fragment"));
    }
    let path = format!("{}/.well-known/openid-configuration", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

fn normalize_issuer(issuer: &str) -> &str {
    issuer.trim_end_matches('/')
}

async fn discover_provider(issuer: &str) -> Result<OidcDiscoveryDocument, MongoError> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|err| oidc_error(format!("failed to create HTTP client: {err}")))?;
    let response = client
        .get(discovery_url(issuer)?)
        .send()
        .await
        .map_err(|err| oidc_error(format!("failed to load provider metadata: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(oidc_error(format!("provider metadata endpoint returned HTTP {status}")));
    }
    let document = response
        .json::<OidcDiscoveryDocument>()
        .await
        .map_err(|err| oidc_error(format!("invalid provider metadata: {err}")))?;
    if normalize_issuer(&document.issuer) != normalize_issuer(issuer) {
        return Err(oidc_error("provider metadata issuer does not match the MongoDB server response"));
    }
    Url::parse(&document.authorization_endpoint)
        .map_err(|err| oidc_error(format!("invalid authorization endpoint: {err}")))?;
    Url::parse(&document.token_endpoint).map_err(|err| oidc_error(format!("invalid token endpoint: {err}")))?;
    Ok(document)
}

fn random_url_safe_value() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn requested_scopes(scopes: Option<Vec<String>>, supported_scopes: Option<&[String]>) -> String {
    let mut scopes = scopes.unwrap_or_default();
    let supports =
        |candidate: &str| supported_scopes.is_none_or(|supported| supported.iter().any(|scope| scope == candidate));
    if supports("openid") && !scopes.iter().any(|scope| scope == "openid") {
        scopes.insert(0, "openid".to_string());
    }
    if supports("offline_access") && !scopes.iter().any(|scope| scope == "offline_access") {
        scopes.push("offline_access".to_string());
    }
    scopes.join(" ")
}

fn authorization_url(
    endpoint: &str,
    client_id: &str,
    scopes: &str,
    state: &str,
    code_challenge: &str,
) -> Result<Url, MongoError> {
    let mut url = Url::parse(endpoint).map_err(|err| oidc_error(format!("invalid authorization endpoint: {err}")))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", OIDC_REDIRECT_URI)
        .append_pair("scope", scopes)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

async fn write_callback_response(stream: &mut tokio::net::TcpStream, success: bool) {
    let (status, title, body) = if success {
        (
            "200 OK",
            "Authorization received",
            "DBX received the authorization response. Return to DBX while it completes the connection.",
        )
    } else {
        (
            "400 Bad Request",
            "Authentication failed",
            "DBX could not complete authentication. Return to DBX for details.",
        )
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font-family:system-ui,sans-serif;margin:48px;color:#202124}}h1{{font-size:22px}}</style></head><body><h1>{title}</h1><p>{body}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn parse_callback_target(target: &str) -> Result<AuthorizationCallback, String> {
    let url = Url::parse(&format!("http://localhost{target}")).map_err(|err| format!("invalid callback URL: {err}"))?;
    if url.path() != "/redirect" {
        return Err("unexpected callback path".to_string());
    }
    let mut code = None;
    let mut state = None;
    let mut provider_error = None;
    let mut provider_error_description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => provider_error = Some(value.into_owned()),
            "error_description" => provider_error_description = Some(value.into_owned()),
            _ => {}
        }
    }
    if let Some(error) = provider_error {
        let detail = provider_error_description.map(|description| format!(": {description}")).unwrap_or_default();
        return Err(format!("identity provider returned {error}{detail}"));
    }
    Ok(AuthorizationCallback {
        code: code.ok_or_else(|| "callback did not include an authorization code".to_string())?,
        state: state.ok_or_else(|| "callback did not include state".to_string())?,
    })
}

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, MongoError> {
    loop {
        let (mut stream, _) =
            listener.accept().await.map_err(|err| oidc_error(format!("callback listener failed: {err}")))?;
        let mut buffer = Vec::with_capacity(1024);
        loop {
            if buffer.len() == MAX_CALLBACK_REQUEST_BYTES {
                return Err(oidc_error("browser callback request exceeded the size limit"));
            }
            let mut chunk = [0_u8; 1024];
            let remaining = MAX_CALLBACK_REQUEST_BYTES - buffer.len();
            let read_len = remaining.min(chunk.len());
            let bytes_read = stream
                .read(&mut chunk[..read_len])
                .await
                .map_err(|err| oidc_error(format!("failed to read browser callback: {err}")))?;
            if bytes_read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..bytes_read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&buffer);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or_else(|| oidc_error("invalid browser callback request"))?;
        let callback = match parse_callback_target(target) {
            Ok(callback) => callback,
            Err(error) if error == "unexpected callback path" => {
                write_callback_response(&mut stream, false).await;
                continue;
            }
            Err(error) => {
                write_callback_response(&mut stream, false).await;
                return Err(oidc_error(error));
            }
        };
        if callback.state != expected_state {
            write_callback_response(&mut stream, false).await;
            return Err(oidc_error("browser callback state did not match the authorization request"));
        }
        write_callback_response(&mut stream, true).await;
        return Ok(callback.code);
    }
}

async fn request_token(token_endpoint: &str, parameters: &[(&str, &str)]) -> Result<OidcTokenResponse, MongoError> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|err| oidc_error(format!("failed to create HTTP client: {err}")))?;
    let response = client
        .post(token_endpoint)
        .form(parameters)
        .send()
        .await
        .map_err(|err| oidc_error(format!("token request failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error_description")
                    .or_else(|| value.get("error"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| body.chars().take(300).collect());
        return Err(oidc_error(format!("token endpoint returned HTTP {status}: {detail}")));
    }
    let token = response
        .json::<OidcTokenResponse>()
        .await
        .map_err(|err| oidc_error(format!("invalid token response: {err}")))?;
    if token.access_token.trim().is_empty() {
        return Err(oidc_error("token response did not include an access token"));
    }
    Ok(token)
}

fn driver_token_response(token: OidcTokenResponse, previous_refresh_token: Option<String>) -> IdpServerResponse {
    let expires = token.expires_in.and_then(|seconds| Instant::now().checked_add(Duration::from_secs(seconds)));
    IdpServerResponse::builder()
        .access_token(token.access_token)
        .expires(expires)
        .refresh_token(token.refresh_token.or(previous_refresh_token))
        .build()
}

async fn authenticate(
    context: CallbackContext,
    opener: MongoOidcBrowserOpener,
) -> Result<IdpServerResponse, MongoError> {
    let info =
        context.idp_info.ok_or_else(|| oidc_error("MongoDB server did not provide identity provider details"))?;
    let client_id = info.client_id.ok_or_else(|| oidc_error("MongoDB server did not provide an OIDC client ID"))?;
    let discovery = discover_provider(&info.issuer).await?;

    if let Some(refresh_token) = context.refresh_token.clone() {
        if let Ok(token) = request_token(
            &discovery.token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
                ("refresh_token", refresh_token.as_str()),
            ],
        )
        .await
        {
            return Ok(driver_token_response(token, Some(refresh_token)));
        }
    }

    let _browser_guard = browser_flow_lock().lock().await;
    let listener = TcpListener::bind(OIDC_CALLBACK_ADDRESS)
        .await
        .map_err(|err| oidc_error(format!("cannot listen on {OIDC_REDIRECT_URI}: {err}")))?;
    let state = random_url_safe_value();
    let verifier = random_url_safe_value();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let scopes = requested_scopes(info.request_scopes, discovery.scopes_supported.as_deref());
    let authorization_url =
        authorization_url(&discovery.authorization_endpoint, &client_id, &scopes, &state, &challenge)?;
    opener(authorization_url.as_str()).map_err(oidc_error)?;

    let timeout = context
        .timeout
        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(DEFAULT_CALLBACK_TIMEOUT);
    let code = tokio::time::timeout(timeout, wait_for_callback(listener, &state))
        .await
        .map_err(|_| oidc_error("browser authentication timed out"))??;
    let token = request_token(
        &discovery.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", OIDC_REDIRECT_URI),
            ("code_verifier", verifier.as_str()),
        ],
    )
    .await?;
    Ok(driver_token_response(token, None))
}

pub fn human_callback(opener: MongoOidcBrowserOpener) -> Callback {
    Callback::human(move |context| {
        let opener = opener.clone();
        async move { authenticate(context, opener).await }.boxed()
    })
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        sync::{Arc, Mutex as StdMutex},
        time::{Duration, Instant},
    };

    use mongodb::options::oidc::{CallbackContext, IdpServerInfo};
    use tokio::{io::AsyncWriteExt, net::TcpListener, task::JoinHandle};

    use super::{
        authenticate, authorization_url, discovery_url, parse_callback_target, requested_scopes,
        MongoOidcBrowserOpener, OIDC_REDIRECT_URI,
    };

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0_u8; 1024];
            let read = tokio::io::AsyncReadExt::read(stream, &mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8(request).unwrap()
    }

    async fn write_json_response(stream: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    }

    async fn start_mock_oidc_server(expected_requests: usize) -> (String, Arc<StdMutex<Vec<String>>>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let server_issuer = issuer.clone();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let server_requests = requests.clone();
        let task = tokio::spawn(async move {
            for _ in 0..expected_requests {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await;
                let request_line = request.lines().next().unwrap_or_default().to_string();
                server_requests.lock().unwrap().push(request.clone());
                if request_line.contains("/.well-known/openid-configuration") {
                    let body = serde_json::json!({
                        "issuer": server_issuer,
                        "authorization_endpoint": format!("{server_issuer}/authorize"),
                        "token_endpoint": format!("{server_issuer}/token"),
                        "scopes_supported": ["openid", "profile", "offline_access"]
                    })
                    .to_string();
                    write_json_response(&mut stream, &body).await;
                } else if request.contains("grant_type=refresh_token") {
                    write_json_response(&mut stream, r#"{"access_token":"refreshed-token","expires_in":120}"#).await;
                } else {
                    write_json_response(
                        &mut stream,
                        r#"{"access_token":"authorization-token","refresh_token":"refresh-token","expires_in":120}"#,
                    )
                    .await;
                }
            }
        });
        (issuer, requests, task)
    }

    fn callback_context(issuer: String, refresh_token: Option<String>) -> CallbackContext {
        CallbackContext::builder()
            .timeout(Some(Instant::now() + Duration::from_secs(5)))
            .refresh_token(refresh_token)
            .idp_info(Some(
                IdpServerInfo::builder()
                    .issuer(issuer)
                    .client_id(Some("dbx-client".to_string()))
                    .request_scopes(Some(vec!["profile".to_string()]))
                    .build(),
            ))
            .build()
    }

    #[test]
    fn discovery_url_preserves_issuer_path() {
        assert_eq!(
            discovery_url("https://idp.example/realms/dbx").unwrap().as_str(),
            "https://idp.example/realms/dbx/.well-known/openid-configuration"
        );
    }

    #[test]
    fn authorization_request_uses_pkce_and_registered_redirect() {
        let url = authorization_url(
            "https://idp.example/authorize",
            "dbx-client",
            "openid profile offline_access",
            "expected-state",
            "challenge",
        )
        .unwrap();
        let params = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
        assert_eq!(params.get("response_type").map(|value| value.as_ref()), Some("code"));
        assert_eq!(params.get("redirect_uri").map(|value| value.as_ref()), Some(OIDC_REDIRECT_URI));
        assert_eq!(params.get("code_challenge_method").map(|value| value.as_ref()), Some("S256"));
        assert_eq!(params.get("state").map(|value| value.as_ref()), Some("expected-state"));
    }

    #[test]
    fn required_scopes_are_added_without_duplicates() {
        assert_eq!(requested_scopes(Some(vec!["profile".to_string()]), None), "openid profile offline_access");
        assert_eq!(
            requested_scopes(Some(vec!["openid".to_string(), "offline_access".to_string()]), None),
            "openid offline_access"
        );
        assert_eq!(
            requested_scopes(Some(vec!["profile".to_string()]), Some(&["openid".to_string(), "profile".to_string()])),
            "openid profile"
        );
    }

    #[test]
    fn callback_requires_code_and_state() {
        let callback = parse_callback_target("/redirect?code=abc&state=xyz").unwrap();
        assert_eq!(callback.code, "abc");
        assert_eq!(callback.state, "xyz");
        assert!(parse_callback_target("/redirect?error=access_denied&error_description=cancelled")
            .unwrap_err()
            .contains("access_denied: cancelled"));
    }

    #[tokio::test]
    async fn authorization_code_flow_exchanges_pkce_code() {
        let (issuer, requests, server) = start_mock_oidc_server(2).await;
        let opened_url = Arc::new(StdMutex::new(None));
        let captured_url = opened_url.clone();
        let opener: MongoOidcBrowserOpener = Arc::new(move |url| {
            let parsed = reqwest::Url::parse(url).unwrap();
            let state =
                parsed.query_pairs().find_map(|(key, value)| (key == "state").then(|| value.into_owned())).unwrap();
            *captured_url.lock().unwrap() = Some(parsed);
            std::thread::spawn(move || {
                let mut stream = std::net::TcpStream::connect("127.0.0.1:27097").unwrap();
                write!(stream, "GET /redirect?code=authorization-code&state={state}").unwrap();
                std::thread::sleep(Duration::from_millis(10));
                write!(stream, " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                assert!(response.starts_with("HTTP/1.1 200 OK"));
            });
            Ok(())
        });

        let token = authenticate(callback_context(issuer, None), opener).await.unwrap();
        server.await.unwrap();

        assert_eq!(token.access_token, "authorization-token");
        assert_eq!(token.refresh_token.as_deref(), Some("refresh-token"));
        assert!(token.expires.is_some_and(|expires| expires > Instant::now()));
        let authorization_url = opened_url.lock().unwrap().clone().unwrap();
        assert_eq!(
            authorization_url.query_pairs().find(|(key, _)| key == "scope").unwrap().1,
            "openid profile offline_access"
        );
        assert!(authorization_url.query_pairs().any(|(key, value)| key == "code_challenge" && !value.is_empty()));
        let requests = requests.lock().unwrap();
        assert!(requests[1].contains("grant_type=authorization_code"));
        assert!(requests[1].contains("code=authorization-code"));
        assert!(requests[1].contains("code_verifier="));
    }

    #[tokio::test]
    async fn refresh_token_avoids_browser_and_preserves_refresh_token() {
        let (issuer, requests, server) = start_mock_oidc_server(2).await;
        let opener: MongoOidcBrowserOpener = Arc::new(|_| Err("browser should not be opened".to_string()));

        let token =
            authenticate(callback_context(issuer, Some("cached-refresh-token".to_string())), opener).await.unwrap();
        server.await.unwrap();

        assert_eq!(token.access_token, "refreshed-token");
        assert_eq!(token.refresh_token.as_deref(), Some("cached-refresh-token"));
        let requests = requests.lock().unwrap();
        assert!(requests[1].contains("grant_type=refresh_token"));
        assert!(requests[1].contains("refresh_token=cached-refresh-token"));
    }
}
