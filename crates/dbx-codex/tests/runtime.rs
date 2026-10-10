use dbx_codex::runtime::{ensure_runtime, RuntimeHandle, ServiceLease};
use std::path::Path;

#[tokio::test]
async fn missing_binary_is_actionable() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let error = ensure_runtime(&dir.path().join("data"), Path::new("/missing/dbx-web")).await.unwrap_err();
    assert!(error.contains("dbx-web"));
    assert!(error.contains("missing"));
}

#[tokio::test]
async fn concurrent_clients_start_one_service() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let data = dir.path().join("data");
    let (a, b) = tokio::join!(ServiceLease::acquire(&data), ServiceLease::acquire(&data));
    assert_ne!(a.is_ok(), b.is_ok(), "only one child may own the runtime");
    drop((a, b));
    assert!(ServiceLease::acquire(&data).await.is_ok(), "lock must release on shutdown");
}

#[tokio::test]
async fn fresh_data_opens_workbench_before_migration() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let lease = ServiceLease::acquire(&dir.path().join("data")).await.unwrap();
    assert!(lease.listener.as_ref().unwrap().local_addr().unwrap().ip().is_loopback());
    assert_ne!(lease.listener.as_ref().unwrap().local_addr().unwrap().port(), 0);
    assert!(!dir.path().join("data/dbx.db").exists(), "discovery must not require initialized storage");
    let handle = lease.handle();
    let status = serde_json::to_string(&handle).unwrap();
    assert!(!status.contains(&lease.token().unwrap()));
    assert!(!status.contains("token"));
}

#[tokio::test]
async fn foreign_service_is_not_reused() {
    use axum::{routing::get, Router};
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let data = dir.path().join("data");
    let lease = ServiceLease::acquire(&data).await.unwrap();
    let fake = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", fake.local_addr().unwrap());
    lease.publish().unwrap();
    let foreign = RuntimeHandle { base_url: url.parse().unwrap(), ..lease.handle() };
    std::fs::write(data.join("runtime.json"), serde_json::to_vec(&foreign).unwrap()).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(fake, Router::new().route("/_codex/status", get(|| async { "not dbx" }))).await.unwrap();
    });
    let error = ensure_runtime(&data, Path::new("/missing/dbx-web")).await.unwrap_err();
    assert!(error.contains("authenticated"), "{error}");
    assert!(reqwest::get(url).await.is_ok(), "foreign service must remain alive");
    server.abort();
}

#[tokio::test]
async fn mismatched_version_fails_without_killing() {
    use axum::{routing::get, Json, Router};
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let data = dir.path().join("data");
    let mut lease = ServiceLease::acquire(&data).await.unwrap();
    lease.publish().unwrap();
    let status = RuntimeHandle { version: "0.0.0".into(), ..lease.handle() };
    std::fs::write(data.join("runtime.json"), serde_json::to_vec(&status).unwrap()).unwrap();
    let listener = lease.take_listener().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/_codex/status", get(move || async move { Json(status) })))
            .await
            .unwrap();
    });
    let error = ensure_runtime(&data, Path::new("/missing/dbx-web")).await.unwrap_err();
    assert!(error.contains("version"), "{error}");
    assert!(reqwest::get(lease.handle().base_url).await.is_ok());
    server.abort();
}

#[tokio::test]
async fn separate_data_directories_have_separate_instances() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let a = ServiceLease::acquire(&dir.path().join("a")).await.unwrap();
    let b = ServiceLease::acquire(&dir.path().join("b")).await.unwrap();
    assert_ne!(a.handle().instance_id, b.handle().instance_id);
    assert_ne!(a.handle().base_url, b.handle().base_url);
    assert_ne!(a.token().unwrap(), b.token().unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_credentials_are_private_and_symlinks_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let data = dir.path().join("data");
    let lease = ServiceLease::acquire(&data).await.unwrap();
    assert_eq!(std::fs::metadata(&data).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(data.join("mcp-token")).unwrap().permissions().mode() & 0o777, 0o600);
    drop(lease);
    let link = dir.path().join("link");
    symlink(&data, &link).unwrap();
    assert!(ServiceLease::acquire(&link).await.is_err());
    std::fs::remove_file(data.join("mcp-token")).unwrap();
    let other = dir.path().join("other");
    std::fs::write(&other, "do not overwrite").unwrap();
    symlink(&other, data.join("mcp-token")).unwrap();
    assert!(ServiceLease::acquire(&data).await.is_err());
    assert_eq!(std::fs::read_to_string(other).unwrap(), "do not overwrite");
}

#[cfg(unix)]
fn fixture_binary(directory: &Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let executable = std::env::current_exe().unwrap();
    let quoted = executable.to_string_lossy().replace('\'', "'\\''");
    let wrapper = directory.join("dbx-web");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nCODEX_RUNTIME_FIXTURE=1 exec '{quoted}' --exact runtime_child_fixture --nocapture\n"),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    wrapper
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_child_fixture() {
    if std::env::var_os("CODEX_RUNTIME_FIXTURE").is_none() {
        return;
    }
    use axum::{routing::get, Json, Router};
    let data = std::path::PathBuf::from(std::env::var_os("DBX_DATA_DIR").unwrap());
    let mut lease = ServiceLease::acquire(&data).await.unwrap();
    let handle = lease.handle();
    let listener = lease.take_listener().unwrap();
    let stop = tokio::sync::Notify::new();
    let stop = std::sync::Arc::new(stop);
    let stop_handler = stop.clone();
    let app = Router::new()
        .route(
            "/_codex/status",
            get(move || {
                let value = handle.clone();
                async move { Json(value) }
            }),
        )
        .route(
            "/stop-fixture",
            get(move || {
                let stop = stop_handler.clone();
                async move {
                    stop.notify_one();
                    "stopped"
                }
            }),
        );
    lease.publish().unwrap();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(15), stop.notified()).await;
        })
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_launchers_reuse_one_child_and_preserve_data() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let binary = fixture_binary(dir.path());
    let data = dir.path().join("data");
    let (a, b) = tokio::join!(ensure_runtime(&data, &binary), ensure_runtime(&data, &binary));
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.instance_id, b.instance_id);
    assert_eq!(a.base_url, b.base_url);
    std::fs::write(data.join("saved-data"), "keep me").unwrap();
    reqwest::get(a.base_url.join("stop-fixture").unwrap()).await.unwrap();
    let until = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while data.join("runtime.json").exists() {
        assert!(tokio::time::Instant::now() < until, "child failed to release registration");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let restarted = ensure_runtime(&data, &binary).await.unwrap();
    assert_ne!(a.instance_id, restarted.instance_id);
    assert_eq!(std::fs::read_to_string(data.join("saved-data")).unwrap(), "keep me");
    reqwest::get(restarted.base_url.join("stop-fixture").unwrap()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_launcher_fixture() {
    if std::env::var_os("CODEX_LAUNCHER_FIXTURE").is_none() {
        return;
    }
    let data = std::path::PathBuf::from(std::env::var_os("CODEX_FIXTURE_DATA").unwrap());
    let binary = std::path::PathBuf::from(std::env::var_os("CODEX_FIXTURE_BINARY").unwrap());
    let result = std::path::PathBuf::from(std::env::var_os("CODEX_FIXTURE_RESULT").unwrap());
    let handle = ensure_runtime(&data, &binary).await.unwrap();
    std::fs::write(result, serde_json::to_vec(&handle).unwrap()).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn background_survives_launcher_exit() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let binary = fixture_binary(dir.path());
    let data = dir.path().join("data");
    let result = dir.path().join("launcher-result.json");
    let output = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "runtime_launcher_fixture", "--nocapture"])
        .env("CODEX_LAUNCHER_FIXTURE", "1")
        .env("CODEX_FIXTURE_DATA", &data)
        .env("CODEX_FIXTURE_BINARY", &binary)
        .env("CODEX_FIXTURE_RESULT", &result)
        .output()
        .await
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    let original: RuntimeHandle = serde_json::from_slice(&std::fs::read(result).unwrap()).unwrap();
    let reused = ensure_runtime(&data, &binary).await.unwrap();
    assert_eq!(reused.instance_id, original.instance_id);
    reqwest::get(reused.base_url.join("stop-fixture").unwrap()).await.unwrap();
}
