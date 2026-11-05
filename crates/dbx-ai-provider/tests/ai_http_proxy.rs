//! Requests run in fresh processes so proxy variables and discovery caches are isolated.
use dbx_ai_provider::ai::{build_ai_http_client, AiConfig};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

struct Mock {
    address: SocketAddr,
    hits: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Mock {
    fn start(bind: &str, status: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind(bind)?;
        let address = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let hits = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_hits = hits.clone();
        let worker_stopped = stopped.clone();
        let worker = thread::spawn(move || {
            while !worker_stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0; 1024];
                        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            let length = stream.read(&mut buffer).unwrap();
                            assert!(length > 0 && request.len() < 65536, "invalid mock request");
                            request.extend_from_slice(&buffer[..length]);
                        }
                        worker_hits.fetch_add(1, Ordering::SeqCst);
                        let body = if status == 200 { "model" } else { "proxy" };
                        write!(
                            stream,
                            "HTTP/1.1 {status} Mock\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("mock accept failed: {error}"),
                }
            }
        });
        Ok(Self { address, hits, stopped, worker: Some(worker) })
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

fn request(endpoint: &str, mode: &str, environment: &Mock, explicit: &str, expected: &Mock, status: u16) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--ignored", "--exact", "proxy_request_child", "--nocapture"]);
    for key in
        ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
    {
        command.env_remove(key);
    }
    command.env("HTTP_PROXY", format!("http://{}", environment.address));
    command.env("HTTPS_PROXY", format!("http://{}", environment.address));
    command.env("ALL_PROXY", format!("http://{}", environment.address));
    command.env("DBX_PROXY_TEST_ENDPOINT", endpoint);
    command.env("DBX_PROXY_TEST_MODE", mode);
    command.env("DBX_PROXY_TEST_EXPLICIT", explicit);
    command.env("DBX_PROXY_TEST_PEER", expected.address.to_string());
    command.env("DBX_PROXY_TEST_STATUS", status.to_string());
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(result) = child.try_wait().unwrap() {
            assert!(result.success(), "child failed: {endpoint}, {mode}");
            break;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("proxy test child timed out: {endpoint}, {mode}");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn loopback_requests(mode: &str) {
    for host in ["127.0.0.1", "127.0.0.2", "localhost", "[::1]"] {
        let bind = if host == "localhost" { "127.0.0.1" } else { host };
        let model = match Mock::start(&format!("{bind}:0"), 200) {
            Ok(mock) => mock,
            Err(error)
                if host == "[::1]"
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
                    ) =>
            {
                eprintln!("IPv6 loopback is unavailable: {error}");
                continue;
            }
            Err(error) => panic!("cannot bind model mock: {error}"),
        };
        let proxy = Mock::start("127.0.0.1:0", 502).unwrap();
        let endpoint = format!("http://{host}:{}/v1/models", model.address.port());
        let explicit = match mode {
            "valid" => format!("http://{}", proxy.address),
            "invalid" => "not a proxy url".to_owned(),
            _ => String::new(),
        };
        request(&endpoint, mode, &proxy, &explicit, &model, 200);
        assert_eq!(model.hits.load(Ordering::SeqCst), 1);
        assert_eq!(proxy.hits.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn loopback_bypasses_automatic_proxy_when_disabled() {
    loopback_requests("disabled");
}

#[test]
fn loopback_bypasses_automatic_proxy_with_empty_explicit_proxy() {
    loopback_requests("empty");
}

#[test]
fn loopback_bypasses_valid_explicit_proxy() {
    loopback_requests("valid");
}

#[test]
fn loopback_ignores_invalid_explicit_proxy() {
    loopback_requests("invalid");
}

#[test]
fn public_endpoint_preserves_automatic_and_explicit_proxy_priority() {
    let automatic = Mock::start("127.0.0.1:0", 502).unwrap();
    let explicit = Mock::start("127.0.0.1:0", 502).unwrap();
    let endpoint = "http://dbx-proxy-regression.invalid/v1/models";
    request(endpoint, "disabled", &automatic, "", &automatic, 502);
    request(endpoint, "valid", &automatic, &format!("http://{}", explicit.address), &explicit, 502);
    assert_eq!(automatic.hits.load(Ordering::SeqCst), 1);
    assert_eq!(explicit.hits.load(Ordering::SeqCst), 1);
}

#[test]
#[ignore = "invoked only by the parent tests in a fresh proxy environment"]
fn proxy_request_child() {
    let endpoint = std::env::var("DBX_PROXY_TEST_ENDPOINT").unwrap();
    let mode = std::env::var("DBX_PROXY_TEST_MODE").unwrap();
    let config: AiConfig = serde_json::from_value(serde_json::json!({
        "provider": "openai-compatible", "endpoint": endpoint,
        "proxyEnabled": mode != "disabled", "proxyUrl": std::env::var("DBX_PROXY_TEST_EXPLICIT").unwrap()
    }))
    .unwrap();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let client = build_ai_http_client(&config, 5).unwrap();
        let response = client.get(&endpoint).send().await.unwrap();
        let expected_status: u16 = std::env::var("DBX_PROXY_TEST_STATUS").unwrap().parse().unwrap();
        assert_eq!(response.status().as_u16(), expected_status);
        assert_eq!(response.remote_addr().unwrap().to_string(), std::env::var("DBX_PROXY_TEST_PEER").unwrap());
        assert_eq!(response.text().await.unwrap(), if expected_status == 200 { "model" } else { "proxy" });
    });
}
