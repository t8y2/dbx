//! End-to-end OIDC integration test: in-process mock IdP (axum) + the real dbx-web binary.
//!
//! Covers: discovery → authorize (state/PKCE capture) → mock IdP code issuance →
//! token exchange (PKCE verifier check) → id_token JWKS verification → session cookie
//! → /api/auth/check carrying the identity. The legacy password-login regression is covered here too.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rsa::RsaPrivateKey;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// The mock IdP's captured authorization request (redirect_uri / state / nonce / code_challenge).
#[derive(Clone, Debug)]
struct CapturedAuthorize {
    redirect_uri: String,
    nonce: String,
    code_challenge: String,
}

struct MockIdp {
    key: EncodingKey,
    kid: &'static str,
    issuer: String,
    captured: Arc<Mutex<Option<CapturedAuthorize>>>,
    issued_code: Arc<Mutex<Option<(String, CapturedAuthorize)>>>,
    /// RP-initiated logout: the `post_logout_redirect_uri` the IdP received.
    captured_logout: Arc<Mutex<Option<String>>>,
}

#[derive(serde::Deserialize)]
struct AuthorizeParams {
    redirect_uri: String,
    state: String,
    nonce: String,
    code_challenge: String,
}

#[derive(serde::Deserialize)]
struct TokenParams {
    grant_type: String,
    code: String,
    redirect_uri: String,
    code_verifier: String,
}

#[derive(serde::Deserialize)]
struct LogoutParams {
    post_logout_redirect_uri: String,
}

impl MockIdp {
    fn router(self: &Arc<Self>) -> Router {
        let discovery_idp = self.clone();
        let discovery = get(move || {
            let issuer = discovery_idp.issuer.clone();
            async move {
                Json(json!({
                    "issuer": issuer,
                    "authorization_endpoint": format!("{issuer}/authorize"),
                    "token_endpoint": format!("{issuer}/token"),
                    "jwks_uri": format!("{issuer}/jwks"),
                    "end_session_endpoint": format!("{issuer}/logout"),
                }))
            }
        });

        let authorize_idp = self.clone();
        let authorize = get(move |Query(params): Query<AuthorizeParams>| {
            let idp = authorize_idp.clone();
            async move {
                let captured = CapturedAuthorize {
                    redirect_uri: params.redirect_uri.clone(),
                    nonce: params.nonce.clone(),
                    code_challenge: params.code_challenge.clone(),
                };
                *idp.captured.lock().await = Some(captured.clone());
                let code = "mock-code-123";
                *idp.issued_code.lock().await = Some((code.to_string(), captured));
                axum::response::Redirect::to(&format!("{}?code={code}&state={}", params.redirect_uri, params.state))
            }
        });

        let token_idp = self.clone();
        let token = post(move |axum::Form(params): axum::Form<TokenParams>| {
            let idp = token_idp.clone();
            async move {
                let Some((code, captured)) = idp.issued_code.lock().await.take() else {
                    return (axum::http::StatusCode::BAD_REQUEST, "unknown code").into_response();
                };
                if params.grant_type != "authorization_code" {
                    return (axum::http::StatusCode::BAD_REQUEST, format!("grant_type mismatch: {}", params.grant_type)).into_response();
                }
                if params.code != code {
                    return (axum::http::StatusCode::BAD_REQUEST, format!("code mismatch: {} != {code}", params.code)).into_response();
                }
                if params.redirect_uri != captured.redirect_uri {
                    return (
                        axum::http::StatusCode::BAD_REQUEST,
                        format!("redirect_uri mismatch: {} != {}", params.redirect_uri, captured.redirect_uri),
                    )
                        .into_response();
                }
                // PKCE S256 check: at authorize time challenge = B64URL(sha256(verifier));
                // the token request carries the verifier, so re-hash it and compare with the stored challenge.
                let recomputed = B64URL.encode(Sha256::digest(params.code_verifier.as_bytes()));
                if recomputed != captured.code_challenge {
                    return (
                        axum::http::StatusCode::BAD_REQUEST,
                        format!("PKCE mismatch: {recomputed} != {}", captured.code_challenge),
                    )
                        .into_response();
                }

                let now = chrono::Utc::now().timestamp();
                let claims = json!({
                    "iss": idp.issuer,
                    "sub": "user-uuid-1",
                    "aud": "dbx-test-client",
                    "exp": now + 600,
                    "iat": now,
                    "nonce": captured.nonce,
                    "preferred_username": "alice",
                    "email": "alice@corp.example",
                    "roles": ["ops-admin"],
                });
                let mut header = Header::new(Algorithm::RS256);
                header.kid = Some(idp.kid.to_string());
                let id_token = jsonwebtoken::encode(&header, &claims, &idp.key).unwrap();
                Json(json!({ "access_token": "at", "id_token": id_token, "token_type": "Bearer" })).into_response()
            }
        });

        let jwks_idp = self.clone();
        let jwks = get(move || {
            let idp = jwks_idp.clone();
            async move {
                let pem = std::env::var("OIDC_TEST_PRIVATE_PEM").unwrap_or_default();
                assert!(!pem.is_empty(), "test private PEM must be provided");
                let key = RsaPrivateKey::from_pkcs8_pem(&pem).unwrap();
                let public = key.to_public_key();
                use rsa::traits::PublicKeyParts;
                let b64_uint = |value: &rsa::BigUint| B64URL.encode(value.to_bytes_be());
                Json(json!({
                    "keys": [{
                        "kty": "RSA",
                        "kid": idp.kid,
                        "use": "sig",
                        "alg": "RS256",
                        "n": b64_uint(public.n()),
                        "e": b64_uint(public.e()),
                    }]
                }))
            }
        });

        let logout_idp = self.clone();
        let logout = get(move |Query(params): Query<LogoutParams>| {
            let idp = logout_idp.clone();
            async move {
                *idp.captured_logout.lock().await = Some(params.post_logout_redirect_uri);
                axum::http::StatusCode::OK
            }
        });

        Router::new()
            .route("/.well-known/openid-configuration", discovery)
            .route("/authorize", authorize)
            .route("/token", token)
            .route("/jwks", jwks)
            .route("/logout", logout)
    }
}

/// Spawns the dbx-web binary; returns (server-log path, child).
/// `kill_on_drop(true)` requires the caller to hold the child handle, or the process dies instantly.
async fn spawn_web(
    data_dir: &std::path::Path,
    port: u16,
    extra_env: Vec<(&str, String)>,
) -> (std::path::PathBuf, tokio::process::Child) {
    let log_path = data_dir.join("server.log");
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_dbx-web"));
    // tracing_subscriber::fmt writes to stdout by default, so both stdout/stderr must land in the log file
    // (opened in append mode so the two handles do not truncate each other).
    let log_file = std::fs::File::options().create(true).append(true).open(&log_path).unwrap();
    let log_file_err = log_file.try_clone().unwrap();
    command
        .env("DBX_DATA_DIR", data_dir)
        .env("DBX_PORT", port.to_string())
        .kill_on_drop(true)
        .stdout(log_file)
        .stderr(log_file_err);
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let child = command.spawn().unwrap();
    (log_path, child)
}

fn dump_server_log(log_path: &std::path::Path) {
    let content = std::fs::read_to_string(log_path).unwrap_or_default();
    eprintln!("---- dbx-web server log ----
{content}
---- end ----");
}

/// Polls /api/auth/check until the auth bootstrap answers (required + setup_required fields present).
async fn wait_ready(client: &reqwest::Client, base: &str, server_log: &std::path::Path, server: &mut tokio::process::Child) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(response) = client.get(format!("{base}/api/auth/check")).send().await {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if body["required"] == json!(true) && body["setup_required"] == json!(false) {
                        break;
                    }
                }
            }
            if let Some(status) = server.try_wait().unwrap() {
                dump_server_log(server_log);
                panic!("dbx-web exited {status}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        dump_server_log(server_log);
        panic!("dbx-web readiness timeout");
    });
}

/// Drives authorize → mock IdP → dbx callback (the client must have redirects disabled) and
/// returns (session cookie, post-login `Location`).
async fn oidc_login(client: &reqwest::Client, base: &str, issuer: &str) -> (String, String) {
    let authorize_response = client
        .get(format!("{base}/api/auth/oidc/sso/authorize?next=/connections"))
        .send()
        .await
        .unwrap();
    assert_eq!(authorize_response.status(), axum::http::StatusCode::SEE_OTHER, "{authorize_response:?}");
    let idp_authorize_url = authorize_response.headers().get("location").unwrap().to_str().unwrap().to_string();
    assert!(idp_authorize_url.starts_with(&format!("{issuer}/authorize?")));

    let idp_redirect = client.get(&idp_authorize_url).send().await.unwrap();
    assert_eq!(idp_redirect.status(), axum::http::StatusCode::SEE_OTHER);
    let dbx_callback_url = idp_redirect.headers().get("location").unwrap().to_str().unwrap().to_string();
    assert!(dbx_callback_url.starts_with(&format!("{base}/api/auth/oidc/sso/callback?")));

    let callback_response = client.get(&dbx_callback_url).send().await.unwrap();
    // The success path explicitly returns 302 FOUND (with the cookie header); the error path is a 303 to /login?error=.
    assert_eq!(
        callback_response.status(),
        axum::http::StatusCode::FOUND,
        "{}",
        callback_response.text().await.unwrap().escape_default()
    );
    let set_cookie = match callback_response.headers().get("set-cookie") {
        Some(value) => value.to_str().unwrap().to_string(),
        None => panic!("callback did not set session cookie; callback_url={dbx_callback_url}"),
    };
    assert!(set_cookie.starts_with("dbx_session="));
    let next_location = callback_response.headers().get("location").unwrap().to_str().unwrap().to_string();
    (set_cookie.split(';').next().unwrap().to_string(), next_location)
}

#[tokio::test(flavor = "multi_thread")]
async fn oidc_authorize_callback_flow_creates_authenticated_session() {
    // 1. Test RSA key (the PEM reaches the mock IdP's jwks route via env).
    let mut rng = rand::thread_rng();
    let private_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
    let pem = private_key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap().to_string();
    std::env::set_var("OIDC_TEST_PRIVATE_PEM", &pem);

    // 2. mock IdP。
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let idp_port = listener.local_addr().unwrap().port();
    let idp = Arc::new(MockIdp {
        key: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
        kid: "rsa-test",
        issuer: format!("http://127.0.0.1:{idp_port}"),
        captured: Arc::new(Mutex::new(None)),
        issued_code: Arc::new(Mutex::new(None)),
        captured_logout: Arc::new(Mutex::new(None)),
    });
    tokio::spawn(async move { axum::serve(listener, idp.router()).await.unwrap() });
    let issuer = format!("http://127.0.0.1:{idp_port}");

    // 3. dbx-web: DBX_AUTH_CONFIG injects the OIDC provider (via discovery).
    let directory = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let provider_config = json!([{
        "id": "sso",
        "kind": "oidc",
        "label": "Corp SSO",
        "enabled": true,
        "config": { "issuer": issuer, "client_id": "dbx-test-client", "client_secret": "super-secret", "groups_claim": "roles", "role_map": { "ops-admin": "admin", "*": "member" } }
    }]);
    let (server_log, mut server) = spawn_web(
        directory.path(),
        port,
        vec![
            ("DBX_AUTH_CONFIG", provider_config.to_string()),
            ("DBX_PUBLIC_URL", format!("http://127.0.0.1:{port}")),
            ("RUST_LOG", "dbx_web=debug,tower_http=info".to_string()),
        ],
    )
    .await;

    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if client.get(format!("{base}/api/auth/check")).send().await.is_ok() {
                break;
            }
            if let Some(status) = server.try_wait().unwrap() {
                dump_server_log(&server_log);
                panic!("dbx-web exited {status}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        dump_server_log(&server_log);
        panic!("dbx-web readiness timeout");
    });

    // 4. check: no local users but external providers exist → no setup wizard.
    let check: serde_json::Value = client.get(format!("{base}/api/auth/check")).send().await.unwrap().json().await.unwrap();
    assert_eq!(check["setup_required"], json!(false), "pure-SSO deployment must not request setup: {check}");
    let providers = check["providers"].as_array().unwrap();
    assert!(providers.iter().any(|p| p["id"] == json!("sso") && p["mode"] == json!("redirect")));

    // 5+6. authorize → redirect to the IdP → mock issues the code → callback creates the session
    // and sets the cookie (the client has redirects disabled, so both hops are followed manually).
    let (cookie, next_location) = oidc_login(&client, &base, &issuer).await;
    assert_eq!(next_location, "/connections", "the next redirect target must be preserved");

    // 7. Session usable: check carries the identity (roles claim mapped to admin via role_map).
    let check: serde_json::Value = client
        .get(format!("{base}/api/auth/check"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(check["authenticated"], json!(true));
    assert_eq!(check["user"]["username"], json!("alice"));
    assert_eq!(check["user"]["role"], json!("admin"));
    assert_eq!(check["user"]["provider_id"], json!("sso"));
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_password_login_still_works() {
    let directory = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (server_log, mut server) = spawn_web(directory.path(), port, vec![("DBX_PASSWORD", "legacy-secret".to_string())]).await;

    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(response) = client.get(format!("{base}/api/auth/check")).send().await {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if body["required"] == json!(true) && body["setup_required"] == json!(false) {
                        break;
                    }
                }
            }
            if let Some(status) = server.try_wait().unwrap() {
                dump_server_log(&server_log);
                panic!("dbx-web exited {status}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        dump_server_log(&server_log);
        panic!("dbx-web readiness timeout");
    });

    // The legacy request body (password only, no username) still works.
    let login = client
        .post(format!("{base}/api/auth/login"))
        .json(&json!({ "password": "legacy-secret" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), axum::http::StatusCode::OK);
    let cookie = login.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
    let check: serde_json::Value = client
        .get(format!("{base}/api/auth/check"))
        .header("cookie", cookie.split(';').next().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(check["authenticated"], json!(true));
    assert_eq!(check["user"]["username"], json!("admin"));
    assert_eq!(check["user"]["role"], json!("admin"));

    // Wrong password → 401.
    let bad = client
        .post(format!("{base}/api/auth/login"))
        .json(&json!({ "password": "wrong" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), axum::http::StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread")]
async fn oidc_logout_hands_the_browser_to_the_idp_end_session() {
    // 1. Test RSA key (the PEM reaches the mock IdP's jwks route via env).
    let mut rng = rand::thread_rng();
    let private_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
    let pem = private_key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap().to_string();
    std::env::set_var("OIDC_TEST_PRIVATE_PEM", &pem);

    // 2. mock IdP with an end_session_endpoint (discovery).
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let idp_port = listener.local_addr().unwrap().port();
    let idp = Arc::new(MockIdp {
        key: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
        kid: "rsa-test",
        issuer: format!("http://127.0.0.1:{idp_port}"),
        captured: Arc::new(Mutex::new(None)),
        issued_code: Arc::new(Mutex::new(None)),
        captured_logout: Arc::new(Mutex::new(None)),
    });
    let router = idp.router();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let issuer = idp.issuer.clone();

    // 3. dbx-web with the OIDC provider (via discovery).
    let directory = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}");
    let provider_config = json!([{
        "id": "sso",
        "kind": "oidc",
        "label": "Corp SSO",
        "enabled": true,
        "config": { "issuer": issuer, "client_id": "dbx-test-client", "client_secret": "super-secret", "groups_claim": "roles", "role_map": { "ops-admin": "admin", "*": "member" } }
    }]);
    let (server_log, mut server) = spawn_web(
        directory.path(),
        port,
        vec![("DBX_AUTH_CONFIG", provider_config.to_string()), ("DBX_PUBLIC_URL", base.clone())],
    )
    .await;

    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    wait_ready(&client, &base, &server_log, &mut server).await;

    // 4. SSO login → session cookie.
    let (cookie, _) = oidc_login(&client, &base, &issuer).await;

    // 5. Logout: the local session is destroyed and the response carries the IdP end-session URL.
    let logout: serde_json::Value = client
        .post(format!("{base}/api/auth/logout"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(logout["ok"], json!(true));
    let logout_url = logout["logout_url"].as_str().unwrap_or_else(|| panic!("OIDC session logout must yield logout_url: {logout}")).to_string();
    assert!(
        logout_url.starts_with(&format!("{issuer}/logout?client_id=dbx-test-client&post_logout_redirect_uri=")),
        "unexpected logout_url: {logout_url}"
    );

    // 6. Following the logout URL lands on the IdP, which receives the app login page as the redirect target.
    client.get(&logout_url).send().await.unwrap();
    let captured = idp
        .captured_logout
        .lock()
        .await
        .clone()
        .expect("IdP must receive the RP-initiated logout");
    assert_eq!(captured, format!("{base}/login"));

    // 7. The local session is really gone (the legacy logout semantics still hold).
    let check: serde_json::Value = client
        .get(format!("{base}/api/auth/check"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(check["authenticated"], json!(false));
}
