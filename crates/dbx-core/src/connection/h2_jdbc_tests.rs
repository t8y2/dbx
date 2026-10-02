use super::*;

async fn fixture() -> (AppState, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let (mut state, directory) = super::tests::test_app_state().await;
    let plugins = directory.join("plugins");
    let plugin = plugins.join("jdbc");
    std::fs::create_dir_all(&plugin).unwrap();
    let script = plugin.join("driver.py");
    std::fs::write(
        &script,
        r#"#!/usr/bin/python3
import json, os, sys
sessions = {}
slow_close = set()
with open(os.path.join(os.path.dirname(__file__), 'pids'), 'a') as pids:
    pids.write(str(os.getpid()) + '\n')
for line in sys.stdin:
    request = json.loads(line)
    method, params = request['method'], request.get('params', {})
    session = params.get('jdbcSessionId', 'legacy')
    result = {'pid': os.getpid(), 'session': session}
    response = {'id': request['id']}
    if method == 'jdbcSessionProtocol':
        result = {'version': 2}
    elif method == 'openJdbcSession':
        sessions[session] = None
        if os.path.exists(os.path.join(os.path.dirname(__file__), 'delay-open')):
            open(os.path.join(os.path.dirname(__file__), 'opening'), 'w').close()
            continue
    elif method == 'connect':
        if params['connection'].get('username') == 'fail':
            response['error'] = {'message': 'connect failed'}
        else:
            sessions[session] = params['connection']['connection_string']
            if params['connection'].get('username') == 'delay-close':
                slow_close.add(session)
    elif method == 'closeJdbcSession':
        sessions.pop(session, None)
        if session in slow_close:
            continue
    elif method == 'wait':
        open(os.path.join(os.path.dirname(__file__), 'waiting'), 'w').close()
        continue
    elif method == 'exit':
        sys.exit(0)
    else:
        result['url'] = sessions.get(session)
        result['session_count'] = len(sessions)
    response.setdefault('result', result)
    print(json.dumps(response), flush=True)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(plugin.join("manifest.json"), serde_json::json!({
        "id": "jdbc", "name": "JDBC", "version": "0.1.41", "protocol_version": 1,
        "executable": "driver.py", "drivers": [{"id": "jdbc", "label": "JDBC", "kind": "external", "database_type": "jdbc"}]
    }).to_string()).unwrap();
    state.plugins = PluginRegistry::new_with_app_version(plugins, "0.6.30");
    let mut config = super::tests::mysql_config(None);
    config.db_type = DatabaseType::Jdbc;
    config.connection_string = Some("jdbc:h2:file:./sample;LOCK_TIMEOUT=2000".into());
    config.jdbc_driver_class = Some("org.h2.Driver".into());
    state.configs.write().await.insert(config.id.clone(), config);
    (state, directory)
}

async fn session(state: &AppState, key: &str) -> Arc<PluginDriverSession> {
    match state.pool_handle(key).await.unwrap() {
        PoolKind::ExternalDriver { session, .. } => session,
        _ => panic!("expected external JDBC driver"),
    }
}

async fn identity(session: &PluginDriverSession) -> serde_json::Value {
    session.invoke("identity", serde_json::json!({})).await.unwrap()
}

#[tokio::test]
async fn embedded_h2_jdbc_shares_process_but_preserves_pool_and_session_ownership() {
    let (state, directory) = fixture().await;
    let metadata = state.get_or_create_metadata_pool_for_session("conn", None, None).await.unwrap();
    let first_key = state.get_or_create_pool_for_session("conn", None, Some("tab-a")).await.unwrap();
    let second_key = state.get_or_create_pool_for_session("conn", None, Some("tab-b")).await.unwrap();
    assert_ne!(first_key, second_key);
    assert_ne!(metadata, first_key);
    let metadata_session = session(&state, &metadata).await;
    let first = session(&state, &first_key).await;
    let second = session(&state, &second_key).await;
    let metadata_identity = identity(&metadata_session).await;
    let first_identity = identity(&first).await;
    let second_identity = identity(&second).await;
    assert_eq!(metadata_identity["pid"], first_identity["pid"]);
    assert_eq!(first_identity["pid"], second_identity["pid"]);
    assert_ne!(metadata_identity["session"], first_identity["session"]);
    assert_ne!(first_identity["session"], second_identity["session"]);
    let config = state.configs.read().await["conn"].clone();
    state.test_external_driver_with_info("jdbc", &config).await.unwrap();
    assert_eq!(std::fs::read_to_string(directory.join("plugins/jdbc/pids")).unwrap().lines().count(), 1);
    let mut other = state.configs.read().await["conn"].clone();
    other.id = "other".into();
    other.connection_string = Some("jdbc:h2:~/other;MODE=PostgreSQL".into());
    state.configs.write().await.insert(other.id.clone(), other);
    let key = state.get_or_create_pool_for_session("other", None, Some("tab-c")).await.unwrap();
    let third = session(&state, &key).await;
    let third_identity = identity(&third).await;
    assert_eq!(first_identity["pid"], third_identity["pid"]);
    assert_ne!(first_identity["session"], third_identity["session"]);
    assert_ne!(first_identity["url"], third_identity["url"]);
    state.remove_pool_by_key(&first_key).await;
    assert!(!first.is_available());
    assert_eq!(identity(&second).await["session"], second_identity["session"]);
    let reopened_key = state.get_or_create_pool_for_session("conn", None, Some("tab-a")).await.unwrap();
    assert_eq!(reopened_key, first_key);
    let reopened = identity(session(&state, &reopened_key).await.as_ref()).await;
    assert_eq!(reopened["pid"], second_identity["pid"]);
    assert_ne!(reopened["session"], first_identity["session"]);
    state.shutdown(Duration::from_secs(5)).await;
    assert!(metadata_session.pid().await.is_none());
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn embedded_h2_jdbc_failed_connect_cancel_drop_and_last_close_are_isolated() {
    let (state, directory) = fixture().await;
    let config = state.configs.read().await["conn"].clone();
    let good = state.external_driver_pool("jdbc", &config).await.unwrap();
    let PoolKind::ExternalDriver { session: good, .. } = good else { panic!() };
    let pid = good.pid().await;
    let mut bad = config.clone();
    bad.username = "fail".into();
    assert!(state.external_driver_pool("jdbc", &bad).await.is_err());
    assert_eq!(good.pid().await, pid);
    identity(&good).await;
    let PoolKind::ExternalDriver { session: waiting, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    let pending_session = waiting.clone();
    let pending =
        tokio::spawn(async move { pending_session.invoke::<serde_json::Value>("wait", serde_json::json!({})).await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !directory.join("plugins/jdbc/waiting").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(5), async {
        while waiting.is_available() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    identity(&good).await;
    drop(waiting);
    let PoolKind::ExternalDriver { session: dropped, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    drop(dropped);
    good.shutdown().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while good.pid().await.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let PoolKind::ExternalDriver { session: reopened, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    assert_ne!(reopened.pid().await, pid);
    reopened.shutdown().await;
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn embedded_h2_jdbc_keeps_remote_memory_and_unrelated_drivers_dedicated() {
    let (state, directory) = fixture().await;
    let mut config = state.configs.read().await["conn"].clone();
    for url in
        ["jdbc:h2:tcp://localhost/sample", "jdbc:h2:ssl://localhost/sample", "jdbc:h2:mem:test", "jdbc:other:sample"]
    {
        config.connection_string = Some(url.into());
        let PoolKind::ExternalDriver { session: first, .. } =
            state.external_driver_pool("jdbc", &config).await.unwrap()
        else {
            panic!()
        };
        let PoolKind::ExternalDriver { session: second, .. } =
            state.external_driver_pool("jdbc", &config).await.unwrap()
        else {
            panic!()
        };
        assert_ne!(first.pid().await, second.pid().await);
        assert_eq!(identity(&first).await["session"], "legacy");
        first.shutdown().await;
        second.shutdown().await;
    }
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn embedded_h2_jdbc_url_scope_preserves_native_and_other_vendor_defaults() {
    let mut config = super::tests::mysql_config(None);
    config.db_type = DatabaseType::Jdbc;
    for url in [
        "jdbc:h2:file:/data/example",
        "jdbc:h2:./example",
        "jdbc:h2:~/example;AUTO_SERVER=TRUE",
        "jdbc:h2:/data/example",
        "jdbc:h2:zip:/data/a.zip!/example",
    ] {
        config.connection_string = Some(url.into());
        assert!(is_embedded_h2_jdbc(&config), "{url}");
    }
    for url in [
        "jdbc:h2:tcp://host/db",
        "jdbc:h2:ssl://host/db",
        "jdbc:h2:mem:",
        "jdbc:h2:mem:named",
        "jdbc:h2:",
        "jdbc:postgresql://host/h2",
    ] {
        config.connection_string = Some(url.into());
        assert!(!is_embedded_h2_jdbc(&config), "{url}");
    }
    config.connection_string = Some("jdbc:h2:file:./example".into());
    config.db_type = DatabaseType::H2;
    assert!(!is_embedded_h2_jdbc(&config));
}

#[tokio::test]
async fn embedded_h2_jdbc_rejects_old_plugins_and_preserves_selected_driver_runtime() {
    let (state, directory) = fixture().await;
    let config = state.configs.read().await["conn"].clone();
    let script = directory.join("plugins/jdbc/driver.py");
    let original = std::fs::read_to_string(&script).unwrap();
    std::fs::write(&script, original.replace("'version': 2", "'version': 1")).unwrap();
    let error = state.external_driver_pool("jdbc", &config).await.err().unwrap();
    assert!(error.contains("Update the JDBC plugin"));
    let pid = std::fs::read_to_string(directory.join("plugins/jdbc/pids")).unwrap();
    assert!(!std::process::Command::new("kill")
        .args(["-0", pid.trim()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());
    std::fs::write(&script, original).unwrap();
    let (first, second) =
        tokio::join!(state.external_driver_pool("jdbc", &config), state.external_driver_pool("jdbc", &config));
    let PoolKind::ExternalDriver { session: first, .. } = first.unwrap() else { panic!() };
    let PoolKind::ExternalDriver { session: second, .. } = second.unwrap() else { panic!() };
    assert_eq!(first.pid().await, second.pid().await);
    let mut different_driver = config.clone();
    different_driver.jdbc_driver_paths = vec!["other-selected-version.jar".into()];
    let PoolKind::ExternalDriver { session: different, .. } =
        state.external_driver_pool("jdbc", &different_driver).await.unwrap()
    else {
        panic!()
    };
    assert_ne!(first.pid().await, different.pid().await);
    different.shutdown().await;
    first.shutdown().await;
    second.shutdown().await;
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn embedded_h2_jdbc_last_owner_close_can_race_a_new_session() {
    let (state, directory) = fixture().await;
    let config = state.configs.read().await["conn"].clone();
    for cycle_index in 0..8 {
        let PoolKind::ExternalDriver { session: closing, .. } =
            state.external_driver_pool("jdbc", &config).await.unwrap()
        else {
            panic!()
        };
        let (_, replacement) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(closing.shutdown(), state.external_driver_pool("jdbc", &config))
        })
        .await
        .unwrap();
        let PoolKind::ExternalDriver { session: replacement, .. } = replacement.unwrap() else { panic!() };
        assert!(replacement.is_available(), "cycle {cycle_index}");
        identity(&replacement).await;
        replacement.shutdown().await;
        assert!(replacement.pid().await.is_none());
    }
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn embedded_h2_jdbc_cancelled_open_releases_its_member_and_server_state() {
    let (state, directory) = fixture().await;
    let config = state.configs.read().await["conn"].clone();
    let PoolKind::ExternalDriver { session: survivor, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    std::fs::write(directory.join("plugins/jdbc/delay-open"), "").unwrap();
    {
        let opening = state.external_driver_pool("jdbc", &config);
        tokio::pin!(opening);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    result = &mut opening => panic!("opening unexpectedly finished: {}", result.is_ok()),
                    _ = tokio::task::yield_now() => {
                        if directory.join("plugins/jdbc/opening").exists() { break; }
                    }
                }
            }
        })
        .await
        .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while identity(&survivor).await["session_count"] != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    survivor.shutdown().await;
    assert!(survivor.pid().await.is_none());
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn embedded_h2_jdbc_replaces_dead_runtime_with_sibling_handles_still_alive() {
    let (state, directory) = fixture().await;
    let config = state.configs.read().await["conn"].clone();
    let PoolKind::ExternalDriver { session: first, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    let PoolKind::ExternalDriver { session: sibling, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    let original_pid = first.pid().await;
    assert!(first.invoke::<serde_json::Value>("exit", serde_json::json!({})).await.is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        while first.is_available() || sibling.is_available() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let PoolKind::ExternalDriver { session: replacement, .. } =
        state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    assert_ne!(replacement.pid().await, original_pid);
    assert!(replacement.pid().await.is_some());
    tokio::join!(first.shutdown(), sibling.shutdown());
    identity(&replacement).await;
    replacement.shutdown().await;
    assert!(replacement.pid().await.is_none());
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn embedded_h2_jdbc_timeout_and_interrupted_shutdown_finish_session_cleanup() {
    let (state, directory) = fixture().await;
    let config = state.configs.read().await["conn"].clone();
    let PoolKind::ExternalDriver { session: survivor, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    let PoolKind::ExternalDriver { session: timed, .. } = state.external_driver_pool("jdbc", &config).await.unwrap()
    else {
        panic!()
    };
    let error = timed
        .invoke_with_timeout::<serde_json::Value>("wait", serde_json::json!({}), Some(Duration::from_millis(20)))
        .await
        .unwrap_err();
    assert!(error.contains("timed out"));
    assert!(!timed.is_available());
    timed.shutdown().await;
    identity(&survivor).await;
    let mut delayed = config.clone();
    delayed.username = "delay-close".into();
    let PoolKind::ExternalDriver { session: closing, .. } = state.external_driver_pool("jdbc", &delayed).await.unwrap()
    else {
        panic!()
    };
    let close_session = closing.clone();
    let close = tokio::spawn(async move {
        close_session.shutdown().await;
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while closing.is_available() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    close.abort();
    assert!(close.await.unwrap_err().is_cancelled());
    identity(&survivor).await;
    survivor.shutdown().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while survivor.pid().await.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    closing.shutdown().await;
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}
