use super::*;

fn config(url: &str) -> ConnectionConfig {
    let mut config = super::tests::mysql_config(None);
    config.db_type = DatabaseType::Jdbc;
    config.connection_string = Some(url.into());
    config.jdbc_driver_class = Some("org.postgresql.Driver".into());
    config
}

#[test]
fn postgres_jdbc_pool_keys_preserve_database_role_and_session_identity() {
    let config = config("jdbc:postgresql://localhost/a?sslmode=require");
    let key = |database, session, role| {
        pool_key_for_session_role(
            Some(&config),
            base_pool_key_for_config(Some(&config), "conn", database, None, false),
            session,
            role,
        )
    };
    let mut keys = std::collections::HashSet::new();
    for database in [None, Some("a"), Some("b"), Some(" a"), Some("a "), Some("a:session:x")] {
        for session in [None, Some("tab-a"), Some("tab-b")] {
            for role in [AgentSessionRole::Metadata, AgentSessionRole::Workload] {
                assert!(keys.insert(key(database, session, role)));
            }
        }
    }
    assert_eq!(key(Some("a:session:x"), None, AgentSessionRole::Workload), "conn:database:a%3Asession%3Ax");
    assert_eq!(key(Some(""), None, AgentSessionRole::Workload), "conn");
}

#[test]
fn postgres_jdbc_routing_scope_keeps_other_vendor_pool_defaults() {
    for url in [
        "jdbc:h2:file:./sample",
        "jdbc:h2:tcp://localhost/sample",
        "jdbc:h2:mem:sample",
        "jdbc:hive2://localhost/default",
        "jdbc:kingbase8://localhost/a",
        "jdbc:postgresqlx://localhost/a",
    ] {
        let config = config(url);
        assert!(!is_postgres_jdbc(&config));
        assert_eq!(base_pool_key_for_config(Some(&config), "conn", Some("b"), None, false), "conn");
    }
    let config = config("jdbc:postgresql://localhost/a");
    let target = database_connection_config(&config, Some(" b "));
    assert_eq!(target.database.as_deref(), Some(" b "));
    assert_eq!(target.connection_string, config.connection_string);
    assert_eq!(database_connection_config(&config, None).database, None);
}

async fn fixture() -> (AppState, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let (mut state, directory) = super::tests::test_app_state().await;
    let plugin = directory.join("plugins/jdbc");
    std::fs::create_dir_all(&plugin).unwrap();
    let script = plugin.join("driver.py");
    std::fs::write(
        &script,
        r#"#!/usr/bin/python3
import json, os, sys
database = None
for line in sys.stdin:
    request = json.loads(line)
    method, params = request['method'], request.get('params', {})
    response = {'id': request['id']}
    result = {'pid': os.getpid(), 'database': database}
    if method == 'connect':
        database = params['connection'].get('database') or 'url_default'
        if database in ('missing', 'denied'):
            response['error'] = {'message': 'target database unavailable'}
    elif method == 'listSchemas':
        result = [database + '_only', 'public']
    response.setdefault('result', result)
    print(json.dumps(response), flush=True)
    if method == 'close':
        break
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        plugin.join("manifest.json"),
        serde_json::json!({
            "id": "jdbc", "name": "JDBC", "version": "0.1.41", "protocol_version": 1,
            "executable": "driver.py", "drivers": [{"id": "jdbc", "label": "JDBC", "kind": "external", "database_type": "jdbc"}]
        }).to_string(),
    ).unwrap();
    state.plugins = PluginRegistry::new_with_app_version(directory.join("plugins"), "0.6.30");
    state.configs.write().await.insert("conn".into(), config("jdbc:postgresql://localhost/a"));
    (state, directory)
}

async fn identity(state: &AppState, key: &str) -> serde_json::Value {
    let PoolKind::ExternalDriver { session, .. } = state.pool_handle(key).await.unwrap() else { panic!() };
    session.invoke("identity", serde_json::json!({})).await.unwrap()
}

#[tokio::test]
async fn postgres_jdbc_owning_entries_route_metadata_cache_hits_and_failures() {
    let (state, directory) = fixture().await;
    let mut owners = HashMap::new();
    for database in ["a", "b", "a"] {
        assert_eq!(
            crate::schema::list_schemas_core(&state, "conn", database).await.unwrap(),
            vec![format!("{database}_only"), "public".into()]
        );
        let key = state.get_or_create_metadata_pool_for_session("conn", Some(database), None).await.unwrap();
        let current = identity(&state, &key).await;
        assert_eq!(current["database"], database);
        if let Some(original) = owners.insert(database, current.clone()) {
            assert_eq!(original, current);
        }
        assert_eq!(state.existing_metadata_pool_key_for_session("conn", Some(database), None).await, Some(key));
    }
    assert_ne!(owners["a"]["pid"], owners["b"]["pid"]);
    for database in ["missing", "denied"] {
        assert!(state.get_or_create_metadata_pool_for_session("conn", Some(database), None).await.is_err());
        assert_eq!(state.existing_metadata_pool_key_for_session("conn", Some(database), None).await, None);
    }
    let database_a_pool = state.get_or_create_metadata_pool_for_session("conn", Some("a"), None).await.unwrap();
    assert_eq!(identity(&state, &database_a_pool).await, owners["a"]);
    assert!(state.close_database_pool("conn", Some("b")).await.unwrap());
    assert_eq!(identity(&state, &database_a_pool).await, owners["a"]);
    assert_eq!(state.existing_metadata_pool_key_for_session("conn", Some("b"), None).await, None);
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn postgres_jdbc_owning_entries_separate_concurrent_roles_sessions_and_cleanup() {
    let (state, directory) = fixture().await;
    let (metadata, workload, other_database, other_tab) = tokio::join!(
        state.get_or_create_metadata_pool_for_session("conn", Some("a"), Some("tab")),
        state.get_or_create_pool_for_session("conn", Some("a"), Some("tab")),
        state.get_or_create_pool_for_session("conn", Some("b"), Some("tab")),
        state.get_or_create_pool_for_session("conn", Some("a"), Some("other")),
    );
    let keys = [metadata.unwrap(), workload.unwrap(), other_database.unwrap(), other_tab.unwrap()];
    let mut pids = std::collections::HashSet::new();
    for key in &keys {
        assert!(pids.insert(identity(&state, key).await["pid"].as_i64().unwrap()));
    }
    assert!(state.close_metadata_session_pool("conn", Some("a"), "tab").await.unwrap());
    assert!(state.pool_handle(&keys[0]).await.is_none());
    assert!(state.detach_client_session_pool("conn", Some("a"), "tab").await.unwrap());
    assert!(state.pool_handle(&keys[1]).await.is_none());
    assert_eq!(identity(&state, &keys[2]).await["database"], "b");
    assert_eq!(identity(&state, &keys[3]).await["database"], "a");
    assert!(!state.detach_metadata_pool_after_recovery("conn", Some("b"), None, None, false).await);
    let default = state.get_or_create_pool("conn", None).await.unwrap();
    assert_eq!(identity(&state, &default).await["database"], "url_default");
    state.shutdown(Duration::from_secs(5)).await;
    std::fs::remove_dir_all(directory).unwrap();
}
