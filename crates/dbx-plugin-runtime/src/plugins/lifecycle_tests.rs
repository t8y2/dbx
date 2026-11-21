use std::collections::BTreeMap;
use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use super::{PluginHost, PluginInstallPolicy, PluginPackageInstaller, PluginRegistry, PluginTrustStore};

pub(super) const ID: &str = "sample.lifecycle";

fn package(version: &str) -> Vec<u8> {
    #[cfg(windows)]
    let (executable, script, extra) = (
        "sidecar.cmd",
        "@echo off\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0sidecar.ps1\"\r\n",
        Some(("sidecar.ps1", r#"
while ($null -ne ($line = [Console]::ReadLine())) {
    $r = $line | ConvertFrom-Json
    if ($r.method -eq 'plugin/initialize') {
        if ($env:DBX_LIFECYCLE_STALL -eq '1') {
            [IO.Directory]::CreateDirectory($env:DBX_PLUGIN_DATA_DIR) | Out-Null
            [IO.File]::WriteAllText((Join-Path $env:DBX_PLUGIN_DATA_DIR 'waiting'), 'ready')
            continue
        }
        $result = @{protocolVersion=1; capabilities=@(); plugin=@{id=$env:DBX_PLUGIN_ID; version=$env:DBX_PLUGIN_VERSION}}
    } elseif ($r.method -eq 'closeJdbcSession') {
        if ($env:DBX_JDBC_CLOSE_LOG) { [IO.File]::AppendAllText($env:DBX_JDBC_CLOSE_LOG, $r.params.jdbcSessionId + "`n") }
        if ($r.params.jdbcSessionId -eq 'failed') {
            [Console]::WriteLine((@{jsonrpc='2.0'; id=$r.id; error=@{message='native_job_session_dispose_unknown'}} | ConvertTo-Json -Depth 8 -Compress))
            continue
        }
        $result = @{ok=$true}
    } elseif ($r.method -eq 'close') {
        $result = @{ok=($env:DBX_JDBC_ROOT_CLOSE -ne 'unconfirmed')}
    } elseif ($r.method -eq 'wait') {
        [IO.Directory]::CreateDirectory($env:DBX_PLUGIN_DATA_DIR) | Out-Null
        [IO.File]::WriteAllText((Join-Path $env:DBX_PLUGIN_DATA_DIR 'waiting'), 'ready')
        continue
    } else { $result = $env:DBX_PLUGIN_VERSION }
    [Console]::WriteLine((@{jsonrpc='2.0'; id=$r.id; result=$result} | ConvertTo-Json -Depth 8 -Compress))
}
"#)),
    );
    #[cfg(unix)]
    let (executable, script, extra): (&str, &str, Option<(&str, &str)>) = (
        "sidecar.sh",
        r#"#!/bin/sh
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed -E 's/.*"id":([0-9]+).*/\1/')
  case "$request" in
    *plugin/initialize*)
      if [ "$DBX_LIFECYCLE_STALL" = 1 ]; then mkdir -p "$DBX_PLUGIN_DATA_DIR"; touch "$DBX_PLUGIN_DATA_DIR/waiting"; continue; fi
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"capabilities":[],"plugin":{"id":"%s","version":"%s"}}}\n' "$id" "$DBX_PLUGIN_ID" "$DBX_PLUGIN_VERSION" ;;
    *'"method":"closeJdbcSession"'*)
      case "$request" in
        *'"jdbcSessionId":"failed"'*)
          [ -z "$DBX_JDBC_CLOSE_LOG" ] || printf 'failed\n' >> "$DBX_JDBC_CLOSE_LOG"
          printf '{"jsonrpc":"2.0","id":%s,"error":{"message":"native_job_session_dispose_unknown"}}\n' "$id" ;;
        *)
          [ -z "$DBX_JDBC_CLOSE_LOG" ] || printf 'survivor\n' >> "$DBX_JDBC_CLOSE_LOG"
          printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
      esac ;;
    *'"method":"close"'*)
      if [ "$DBX_JDBC_ROOT_CLOSE" = unconfirmed ]; then ok=false; else ok=true; fi
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":%s}}\n' "$id" "$ok" ;;
    *'"method":"wait"'*) mkdir -p "$DBX_PLUGIN_DATA_DIR"; touch "$DBX_PLUGIN_DATA_DIR/waiting" ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":"%s"}\n' "$id" "$DBX_PLUGIN_VERSION" ;;
  esac
done
"#,
        None,
    );
    let manifest = json!({
        "manifest_version":1, "id":ID, "name":"Lifecycle fixture", "version":version,
        "publisher":"dbx", "engines":{"dbx":">=0.1.0", "host_api":"^1.0"},
        "entrypoints":{"backend":{"protocol_versions":[1],"transport":"stdio-jsonl","executable":executable}}
    })
    .to_string();
    let mut files = BTreeMap::from([("manifest.json", manifest.as_str()), (executable, script)]);
    if let Some((name, content)) = extra {
        files.insert(name, content);
    }
    let checksums: BTreeMap<_, _> =
        files.iter().map(|(name, bytes)| (*name, format!("{:x}", Sha256::digest(bytes.as_bytes())))).collect();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().unix_permissions(0o755);
    for (name, content) in files {
        zip.start_file(name, options).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    zip.start_file("checksums.json", options).unwrap();
    zip.write_all(json!({"algorithm":"sha256","files":checksums}).to_string().as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

pub(super) fn registry(root: &Path) -> PluginRegistry {
    PluginRegistry::new_with_app_version(root.to_path_buf(), "0.6.14")
}

fn installer(root: &Path) -> PluginPackageInstaller {
    PluginPackageInstaller::with_trust_store(root.to_path_buf(), "0.6.14", PluginTrustStore::default())
        .with_lifecycle(registry(root).lifecycle())
}

pub(super) fn install(root: &Path, version: &str) {
    installer(root).install_bytes(&package(version), PluginInstallPolicy::LocalDevelopment).unwrap();
}

async fn version(host: &PluginHost) -> String {
    host.invoke(ID, "version", json!({}), None, Some(Duration::from_secs(5))).await.unwrap()
}

async fn wait_until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("plugin processes and image handles should be released");
}

#[tokio::test]
async fn rollback_drains_every_host_then_uninstall_releases_both_versions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.3");
    install(&root, "0.3.4");
    let first = PluginHost::new(registry(&root));
    let second = PluginHost::new(registry(&root));
    assert_eq!(version(&first).await, "0.3.4");
    assert_eq!(version(&second).await, "0.3.4");
    let runtime = Arc::downgrade(&first.activate(ID).await.unwrap());
    let rollback = installer(&root);
    let result = tokio::task::spawn_blocking(move || rollback.rollback(ID)).await.unwrap().unwrap();
    assert_eq!(result.plugin.manifest.version, "0.3.3");
    assert!(runtime.upgrade().is_none(), "old executable handles must drop before rollback commits");
    assert!(first.list_active().await.is_empty());
    assert!(second.list_active().await.is_empty());
    drop(result);
    assert_eq!(version(&first).await, "0.3.3");
    assert_eq!(version(&second).await, "0.3.3");
    // A third, independent host performs the uninstall while both MCP hosts are still alive.
    PluginHost::new(registry(&root)).uninstall_plugin(ID).await.unwrap();
    assert!(!root.join(ID).exists());
    assert!(first.list_active().await.is_empty());
    assert!(second.list_active().await.is_empty());
}

#[tokio::test]
async fn discovery_is_transient_and_preserves_a_live_session() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.4");
    let host = PluginHost::new(registry(&root));
    let result: String = host.probe(ID, "mcp/tools", json!({}), None).await.unwrap();
    assert_eq!(result, "0.3.4");
    assert!(host.list_active().await.is_empty());
    let session = host.activate(ID).await.unwrap();
    let _: String = host.probe(ID, "mcp/tools", json!({}), None).await.unwrap();
    assert!(Arc::ptr_eq(&session, &host.activate(ID).await.unwrap()));
    host.stop_all().await.unwrap();
}

#[tokio::test]
async fn cancelled_discovery_does_not_leave_a_process_or_block_uninstall() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.4");
    let host = PluginHost::new(registry(&root));
    let marker = registry(&root).plugin_data_dir(ID).join("waiting");
    let probing = host.clone();
    let task = tokio::spawn(async move { probing.probe::<Value>(ID, "wait", json!({}), None).await });
    wait_until(|| marker.exists()).await;
    task.abort();
    let _ = task.await;
    host.uninstall_plugin(ID).await.unwrap();
    assert!(!root.join(ID).exists());
}

#[tokio::test]
async fn cancelled_initialization_releases_the_untracked_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.4");
    let host = PluginHost::new(registry(&root));
    let marker = registry(&root).plugin_data_dir(ID).join("waiting");
    let starting = host.clone();
    let task = tokio::spawn(async move {
        starting.activate_with_env(ID, super::PluginRuntimeEnv::default().with_var("DBX_LIFECYCLE_STALL", "1")).await
    });
    wait_until(|| marker.exists()).await;
    task.abort();
    let _ = task.await;
    assert!(host.list_active().await.is_empty());
    host.uninstall_plugin(ID).await.unwrap();
    assert!(!root.join(ID).exists());
}

#[tokio::test]
async fn rollback_refuses_another_hosts_active_request_without_killing_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.3");
    install(&root, "0.3.4");
    let host = PluginHost::new(registry(&root));
    let marker = registry(&root).plugin_data_dir(ID).join("waiting");
    let requesting = host.clone();
    let task = tokio::spawn(async move { requesting.invoke::<Value>(ID, "wait", json!({}), None, None).await });
    wait_until(|| marker.exists()).await;
    let session = host.activate(ID).await.unwrap();
    let rollback = installer(&root);
    let error = tokio::task::spawn_blocking(move || rollback.rollback(ID)).await.unwrap().unwrap_err();
    assert!(error.contains("another DBX host"), "{error}");
    assert_eq!(session.status().state, super::PluginSessionState::Running);
    assert_eq!(registry(&root).find_plugin(ID).unwrap().unwrap().manifest.version, "0.3.4");
    task.abort();
    let _ = task.await;
    drop(session);
    host.uninstall_plugin(ID).await.unwrap();
}

#[tokio::test]
async fn dropping_the_host_stops_its_cached_process() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.4");
    let host = PluginHost::new(registry(&root));
    let runtime = Arc::downgrade(&host.activate(ID).await.unwrap());
    drop(host);
    wait_until(|| runtime.upgrade().is_none()).await;
    // On Windows this also exercises release of the launcher's working-directory handle.
    std::fs::rename(root.join(ID), root.join("retired")).unwrap();
}

#[tokio::test]
async fn dropping_a_driver_session_releases_its_process_before_uninstall() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.4");
    let registry = registry(&root);
    let driver = super::PluginDriverSession::start(
        registry.find_plugin(ID).unwrap().unwrap(),
        "fixture".to_string(),
        "0.6.14".to_string(),
        super::PluginRuntimeEnv::default(),
        registry.lifecycle().begin_connection(ID, "Fixture").unwrap(),
    )
    .await
    .unwrap();
    let runtime = Arc::downgrade(&driver.sidecar);
    std::thread::spawn(move || drop(driver)).join().unwrap();
    wait_until(|| runtime.upgrade().is_none()).await;
    PluginHost::new(registry).uninstall_plugin(ID).await.unwrap();
    assert!(!root.join(ID).exists());
}

#[test]
fn independent_hosts_refuse_updates_while_real_work_is_active() {
    let temp = tempfile::tempdir().unwrap();
    let first = registry(temp.path()).lifecycle();
    let second = registry(temp.path()).lifecycle();
    let connection = first.begin_connection(ID, "Production").unwrap();
    assert!(second.begin_update(ID).unwrap_err().contains("another DBX host"));
    assert!(second.begin_update("other").is_ok());
    drop(connection);
    let operation = first.begin_operation(ID).unwrap();
    assert!(second.begin_update(ID).is_err());
    drop(operation);
    let update = second.begin_update(ID).unwrap();
    assert!(first.begin_operation(ID).is_err());
    drop(update);
    assert!(first.begin_operation(ID).is_ok());
}

#[tokio::test]
#[ignore = "subprocess fixture for external_host_observes_rollback_and_uninstall"]
async fn external_host_fixture() {
    let root = std::env::var_os("DBX_LIFECYCLE_TEST_ROOT").expect("fixture root");
    let root = Path::new(&root);
    let control = root.parent().unwrap();
    let host = PluginHost::new(registry(root));
    std::fs::write(control.join("ready"), version(&host).await).unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if control.join("quit").exists() {
                break;
            }
            if control.join("probe").exists() && !control.join("observed").exists() {
                std::fs::write(control.join("observed"), version(&host).await).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    host.stop_all().await.unwrap();
}

#[tokio::test]
async fn external_host_observes_rollback_and_uninstall() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    install(&root, "0.3.3");
    install(&root, "0.3.4");
    let mut command = crate::process::new_tokio_command(std::env::current_exe().unwrap());
    command
        .args(["--exact", "plugins::lifecycle_tests::external_host_fixture", "--ignored", "--nocapture"])
        .env("DBX_LIFECYCLE_TEST_ROOT", &root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    wait_until(|| std::fs::read_to_string(temp.path().join("ready")).ok().as_deref() == Some("0.3.4")).await;
    assert_eq!(std::fs::read_to_string(temp.path().join("ready")).unwrap(), "0.3.4");
    let rollback = installer(&root);
    drop(tokio::task::spawn_blocking(move || rollback.rollback(ID)).await.unwrap().unwrap());
    std::fs::write(temp.path().join("probe"), "").unwrap();
    wait_until(|| std::fs::read_to_string(temp.path().join("observed")).ok().as_deref() == Some("0.3.3")).await;
    assert_eq!(std::fs::read_to_string(temp.path().join("observed")).unwrap(), "0.3.3");
    PluginHost::new(registry(&root)).uninstall_plugin(ID).await.unwrap();
    assert!(!root.join(ID).exists());
    std::fs::write(temp.path().join("quit"), "").unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(8), child.wait()).await.unwrap().unwrap().success());
}
