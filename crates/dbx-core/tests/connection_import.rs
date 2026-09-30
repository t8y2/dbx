//! DBX bundle imports use synthetic fixtures and isolated encrypted storage only.
use dbx_core::{
    models::connection::{ConnectionConfig, TransportLayerConfig},
    persistence::test_storage,
    storage::{McpGlobalPolicy, Storage},
};
use serde_json::{json, Value};

fn connection(id: &str, name: &str) -> Value {
    json!({
        "id": id, "name": name, "db_type": "sqlite", "host": ":memory:", "port": 0,
        "username": "fixture-user", "password": "import-password-secret", "database": "fixture",
        "connection_string": "import-dsn-secret", "url_params": "token=import-url-secret",
        "connection_secrets": {"token": "import-plugin-secret"},
        "init_script": "import-script-secret", "note": "Preserved note", "color": "#123456",
        "read_only": true, "is_production": true, "visible_databases": ["fixture"],
        "default_schema": "main", "query_timeout_secs": 47,
        "transport_layers": [{"type":"ssh", "id":"source-layer", "enabled":true,
            "host":"bastion.invalid", "port":22, "user":"deploy", "password":"import-ssh-secret",
            "key_path":"/synthetic/key", "key_passphrase":"import-key-secret", "auth_method":"key+password"}]
    })
}

fn profile(id: &str) -> Value {
    json!({"type":"ssh", "id":id, "name":"Fixture bastion", "enabled":true,
        "host":"profile.invalid", "port":22, "user":"deploy", "password":"import-profile-secret",
        "key_path":"/synthetic/profile-key", "key_passphrase":"import-profile-key-secret"})
}

async fn writable_storage(path: &std::path::Path) -> Storage {
    let storage = test_storage::open(path).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    storage
}

fn assert_report(report: impl serde::Serialize, dry_run: bool, input: usize, imported: usize, skipped: usize) {
    let report = serde_json::to_value(report).unwrap();
    assert_eq!(report["dry_run"], dry_run);
    assert_eq!(report["input_count"], input);
    assert_eq!(report["imported_count"], imported);
    assert_eq!(report["skipped_count"], skipped);
    let text = report.to_string();
    for secret in [
        "import-password-secret",
        "import-dsn-secret",
        "import-url-secret",
        "import-plugin-secret",
        "import-script-secret",
        "import-ssh-secret",
        "import-key-secret",
        "import-profile-secret",
        "import-profile-key-secret",
    ] {
        assert!(!text.contains(secret), "import report exposed a credential");
    }
}

#[tokio::test]
async fn preview_is_non_mutating_and_import_preserves_full_settings_and_existing_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("dbx.db");
    let storage = writable_storage(&path).await;
    let existing: ConnectionConfig = serde_json::from_value(connection("existing", "Existing")).unwrap();
    storage.add_connection_for_mcp(existing.clone()).await.unwrap();
    let source = connection("source", "Imported");
    let bundle = json!({"connections": [source.clone()]});
    assert_report(storage.import_connections_for_mcp(bundle.clone(), true).await.unwrap(), true, 1, 1, 0);
    assert_eq!(storage.load_connections().await.unwrap(), vec![existing.clone()]);
    assert!(storage.load_sidebar_layout().await.unwrap().is_none());
    assert!(storage.load_tunnel_profiles().await.unwrap().is_empty());

    assert_report(storage.import_connections_for_mcp(bundle.clone(), false).await.unwrap(), false, 1, 1, 0);
    let reopened = test_storage::open(&path).await.unwrap();
    let configs = reopened.load_connections().await.unwrap();
    assert_eq!(configs.len(), 2);
    assert_eq!(configs.iter().find(|c| c.id == "existing").unwrap(), &existing);
    let imported = configs.iter().find(|c| c.name == "Imported").unwrap();
    assert_ne!(imported.id, "source");
    let mut expected: ConnectionConfig = serde_json::from_value(source).unwrap();
    expected.id = imported.id.clone();
    // Layer identities may be regenerated while all layer settings remain intact.
    let mut actual = serde_json::to_value(imported).unwrap();
    let mut expected = serde_json::to_value(expected).unwrap();
    actual["transport_layers"][0].as_object_mut().unwrap().remove("id");
    expected["transport_layers"][0].as_object_mut().unwrap().remove("id");
    assert_eq!(actual, expected);
    assert_report(storage.import_connections_for_mcp(bundle, false).await.unwrap(), false, 1, 0, 1);
    assert_eq!(storage.load_connections().await.unwrap(), configs);

    let database = rusqlite::Connection::open(&path).unwrap();
    let plaintext: i64 =
        database.query_row("SELECT COUNT(*) FROM connection_secrets WHERE secret != ''", [], |r| r.get(0)).unwrap();
    assert_eq!(plaintext, 0, "imported credentials must use the encrypted secret store");
    let public_configs: String =
        database.query_row("SELECT group_concat(config_json) FROM connections", [], |r| r.get(0)).unwrap();
    for secret in [
        "import-password-secret",
        "import-dsn-secret",
        "import-url-secret",
        "import-plugin-secret",
        "import-ssh-secret",
        "import-key-secret",
    ] {
        assert!(!public_configs.contains(secret), "credential leaked into public connection JSON");
    }
}

#[tokio::test]
async fn duplicate_identity_never_replaces_saved_credentials_or_settings() {
    let directory = tempfile::tempdir().unwrap();
    let storage = writable_storage(&directory.path().join("dbx.db")).await;
    let existing: ConnectionConfig = serde_json::from_value(connection("existing", "Existing")).unwrap();
    storage.add_connection_for_mcp(existing.clone()).await.unwrap();
    let mut duplicate = connection("different-source-id", "Existing");
    duplicate["password"] = json!("replacement-must-not-be-written");
    duplicate["read_only"] = json!(false);
    duplicate["note"] = json!("replacement note");
    assert_report(
        storage.import_connections_for_mcp(json!({"connections":[duplicate]}), false).await.unwrap(),
        false,
        1,
        0,
        1,
    );
    assert_eq!(storage.load_connections().await.unwrap(), vec![existing]);
}

#[tokio::test]
async fn layout_and_tunnel_ids_are_remapped_without_overwriting_existing_data() {
    let directory = tempfile::tempdir().unwrap();
    let storage = writable_storage(&directory.path().join("dbx.db")).await;
    let existing: ConnectionConfig = serde_json::from_value(connection("source", "Existing")).unwrap();
    storage.add_connection_for_mcp(existing.clone()).await.unwrap();
    let existing_profile: TransportLayerConfig = serde_json::from_value(profile("source-profile")).unwrap();
    storage.save_tunnel_profiles(&[existing_profile.clone()]).await.unwrap();
    let existing_layout = json!({"groups":[{"id":"source-group","name":"Existing group","collapsed":false}],
        "order":[{"type":"group","id":"source-group","children":[{"type":"connection","id":"source"}]}]});
    storage.save_sidebar_layout(&existing_layout).await.unwrap();
    let mut imported = connection("source", "Imported");
    imported["transport_layers"][0]["profile_id"] = json!("source-profile");
    let bundle = json!({"connections":[imported], "tunnelProfiles":[profile("source-profile")],
        "layout":{"groups":[{"id":"source-group","name":"Imported group","collapsed":true}],
            "order":[{"type":"group","id":"source-group","children":[{"type":"connection","id":"source"}]}]}});
    assert_report(storage.import_connections_for_mcp(bundle.clone(), true).await.unwrap(), true, 1, 1, 0);
    assert_eq!(storage.load_sidebar_layout().await.unwrap(), Some(existing_layout.clone()));
    assert_eq!(storage.load_tunnel_profiles().await.unwrap(), vec![existing_profile.clone()]);
    assert_report(storage.import_connections_for_mcp(bundle.clone(), false).await.unwrap(), false, 1, 1, 0);
    let saved = storage.load_connections().await.unwrap();
    assert_eq!(saved.iter().find(|c| c.name == "Existing").unwrap(), &existing);
    let imported = saved.iter().find(|c| c.name == "Imported").unwrap();
    assert_ne!(imported.id, "source");
    let profiles = storage.load_tunnel_profiles().await.unwrap();
    assert_eq!(profiles.len(), 2);
    assert_eq!(profiles.iter().find(|p| p.id() == "source-profile").unwrap(), &existing_profile);
    let imported_profile = profiles.iter().find(|p| p.id() != "source-profile").unwrap();
    assert_eq!(imported.transport_layers[0].profile_id(), imported_profile.id());
    let mut expected_profile = profile("source-profile");
    expected_profile["id"] = json!(imported_profile.id());
    assert_eq!(imported_profile, &serde_json::from_value::<TransportLayerConfig>(expected_profile).unwrap());
    let layout = storage.load_sidebar_layout().await.unwrap().unwrap();
    assert!(layout["groups"].as_array().unwrap().contains(&existing_layout["groups"][0]));
    assert!(layout["order"].as_array().unwrap().contains(&existing_layout["order"][0]));
    let paths = dbx_core::mcp_policy::connection_group_paths(&layout).unwrap();
    let imported_path = paths.get(&imported.id).unwrap();
    assert_eq!(imported_path.names, vec!["Imported group"]);
    assert_ne!(imported_path.ids[0], "source-group");
    assert_report(storage.import_connections_for_mcp(bundle, false).await.unwrap(), false, 1, 0, 1);
    assert_eq!(storage.load_tunnel_profiles().await.unwrap(), profiles);
    assert_eq!(storage.load_sidebar_layout().await.unwrap(), Some(layout));
}

#[tokio::test]
async fn legacy_arrays_and_dbx_config_envelopes_are_supported() {
    for bundle in [
        json!([connection("source", "Legacy")]),
        json!({"format":"dbx-config", "connections":[connection("source", "Legacy")]}),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let storage = writable_storage(&directory.path().join("dbx.db")).await;
        assert_report(storage.import_connections_for_mcp(bundle, false).await.unwrap(), false, 1, 1, 0);
        assert_eq!(storage.load_connections().await.unwrap()[0].name, "Legacy");
    }
}

#[tokio::test]
async fn invalid_bundles_fail_without_partial_import_or_secret_echo() {
    let mut invalid_port = connection("invalid", "Invalid");
    invalid_port["port"] = json!(65536);
    let mut missing_profile = connection("missing-profile", "Missing profile");
    missing_profile["transport_layers"][0]["profile_id"] = json!("absent");
    for invalid in [
        json!({"connections":[connection("valid", "Valid"), invalid_port]}),
        json!({"connections":[connection("same-id", "First"), connection("same-id", "Second")]}),
        json!({"connections":[connection("valid", "Valid"), missing_profile]}),
        json!({"connections":[connection("valid", "Valid")], "layout":{"groups":[],"order":[{"type":"invalid","id":"absent"}]}}),
        json!({"format":"dbx-encrypted", "version":1, "salt":"synthetic", "iv":"synthetic", "data":"import-password-secret"}),
        json!({"connections":"import-password-secret"}),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let storage = writable_storage(&directory.path().join("dbx.db")).await;
        let existing: ConnectionConfig = serde_json::from_value(connection("existing", "Existing")).unwrap();
        storage.add_connection_for_mcp(existing.clone()).await.unwrap();
        for dry_run in [true, false] {
            let error = storage.import_connections_for_mcp(invalid.clone(), dry_run).await.unwrap_err();
            assert!(!error.contains("import-password-secret"));
            assert_eq!(storage.load_connections().await.unwrap(), vec![existing.clone()]);
            assert!(storage.load_tunnel_profiles().await.unwrap().is_empty());
            assert!(storage.load_sidebar_layout().await.unwrap().is_none());
        }
    }
}

#[tokio::test]
async fn import_rechecks_global_policy_and_scopes_before_apply() {
    for policy in [
        McpGlobalPolicy { read_only: true, ..Default::default() },
        McpGlobalPolicy { read_only: false, allowed_connection_ids: Some(vec!["other".into()]), ..Default::default() },
        McpGlobalPolicy {
            read_only: false,
            allowed_tool_names: Some(vec!["dbx_list_connections".into()]),
            ..Default::default()
        },
    ] {
        let directory = tempfile::tempdir().unwrap();
        let storage = writable_storage(&directory.path().join("dbx.db")).await;
        let bundle = json!({"connections":[connection("source", "Imported")]});
        storage.import_connections_for_mcp(bundle.clone(), true).await.unwrap();
        storage.save_mcp_global_policy(&policy).await.unwrap();
        if policy.read_only {
            assert!(storage.import_connections_for_mcp(bundle.clone(), true).await.is_ok());
        } else {
            assert!(storage.import_connections_for_mcp(bundle.clone(), true).await.is_err());
        }
        assert!(storage.import_connections_for_mcp(bundle, false).await.is_err());
        assert!(storage.load_connections().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn persistence_failure_rolls_back_connections_profiles_layout_and_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("dbx.db");
    let storage = writable_storage(&path).await;
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_import_layout BEFORE INSERT ON sidebar_layout BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;").unwrap();
    let mut imported = connection("source", "Imported");
    imported["transport_layers"][0]["profile_id"] = json!("profile");
    let bundle = json!({"connections":[imported], "tunnelProfiles":[profile("profile")],
        "layout":{"groups":[], "order":[{"type":"connection","id":"source"}]}});
    assert!(storage.import_connections_for_mcp(bundle, false).await.is_err());
    assert!(storage.load_connections().await.unwrap().is_empty());
    assert!(storage.load_tunnel_profiles().await.unwrap().is_empty());
    assert!(storage.load_sidebar_layout().await.unwrap().is_none());
    let count: i64 = database.query_row("SELECT COUNT(*) FROM connection_secrets", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn desktop_compatible_encrypted_fixture_decrypts_without_exposing_secrets() {
    use dbx_core::persistence::connection_import::decrypt_import_payload;
    // Synthetic PBKDF2-SHA256/AES-256-GCM fixture generated independently of the Rust decryptor.
    let encrypted: Value = serde_json::from_str(include_str!("fixtures/connection_import_encrypted.json")).unwrap();
    let wrong = decrypt_import_payload(encrypted.clone(), b"incorrect-passphrase").unwrap_err();
    assert!(wrong.starts_with("IMPORT_DECRYPT_FAILED:"));
    assert!(!wrong.contains("incorrect-passphrase"));
    let bundle = decrypt_import_payload(encrypted.clone(), b"synthetic-import-passphrase").unwrap();
    let directory = tempfile::tempdir().unwrap();
    let storage = writable_storage(&directory.path().join("dbx.db")).await;
    let preview = storage.import_connections_for_mcp(bundle.clone(), true).await.unwrap();
    assert!(!serde_json::to_string(&preview).unwrap().contains("synthetic-encrypted-password"));
    assert_report(preview, true, 1, 1, 0);
    assert!(storage.load_connections().await.unwrap().is_empty());
    let applied = storage.import_connections_for_mcp(bundle, false).await.unwrap();
    assert!(!serde_json::to_string(&applied).unwrap().contains("synthetic-encrypted-password"));
    assert_report(applied, false, 1, 1, 0);
    assert_eq!(storage.load_connections().await.unwrap()[0].password, "synthetic-encrypted-password");
    for field in ["data", "iv", "salt", "version"] {
        let mut damaged = encrypted.clone();
        damaged[field] = json!("invalid-ciphertext");
        assert!(decrypt_import_payload(damaged, b"synthetic-import-passphrase").is_err());
    }
}

#[tokio::test]
async fn equal_names_with_distinct_complete_identities_are_preserved_and_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let storage = writable_storage(&directory.path().join("dbx.db")).await;
    let existing: ConnectionConfig = serde_json::from_value(connection("existing", "Shared name")).unwrap();
    storage.add_connection_for_mcp(existing.clone()).await.unwrap();
    let mut other_host = connection("source-host", "Shared name");
    other_host["host"] = json!("different.invalid");
    let mut other_database = connection("source-database", "Shared name");
    other_database["database"] = json!("another-database");
    let mut other_type = connection("source-type", "Shared name");
    other_type["db_type"] = json!("postgres");
    let mut other_port = connection("source-port", "Shared name");
    other_port["port"] = json!(12345);
    let bundle = json!({"connections":[other_host, other_database, other_type, other_port]});
    assert_report(storage.import_connections_for_mcp(bundle.clone(), false).await.unwrap(), false, 4, 4, 0);
    let saved = storage.load_connections().await.unwrap();
    assert_eq!(saved.len(), 5);
    assert_eq!(saved.iter().find(|c| c.id == "existing").unwrap(), &existing);
    assert!(saved.iter().all(|c| c.name == "Shared name"));
    assert_report(storage.import_connections_for_mcp(bundle, false).await.unwrap(), false, 4, 0, 4);
    assert_eq!(storage.load_connections().await.unwrap(), saved);
}

#[tokio::test]
async fn legacy_driver_canonicalization_does_not_break_duplicate_detection() {
    let directory = tempfile::tempdir().unwrap();
    let storage = writable_storage(&directory.path().join("dbx.db")).await;
    let mut legacy = connection("legacy", "Legacy TDengine");
    legacy["db_type"] = json!("mysql");
    legacy["driver_profile"] = json!("tdengine");
    legacy["port"] = json!(6030);
    let bundle = json!({"connections":[legacy]});
    assert_report(storage.import_connections_for_mcp(bundle.clone(), false).await.unwrap(), false, 1, 1, 0);
    assert_report(storage.import_connections_for_mcp(bundle, false).await.unwrap(), false, 1, 0, 1);
    assert_eq!(storage.load_connections().await.unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn non_regular_import_input_is_rejected_without_blocking() {
    use dbx_core::persistence::connection_import::read_import_file;
    use std::{process::Command, sync::mpsc, time::Duration};
    let directory = tempfile::tempdir().unwrap();
    assert!(read_import_file(directory.path(), false).is_err());
    let fifo = directory.path().join("fixture.fifo");
    assert!(Command::new("mkfifo").arg("-m").arg("600").arg(&fifo).status().unwrap().success());
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(read_import_file(&fifo, false));
    });
    let result =
        receive.recv_timeout(Duration::from_secs(3)).expect("reading a FIFO must not block waiting for a writer");
    assert!(result.is_err());
}

#[cfg(unix)]
#[test]
fn encrypted_import_refuses_readable_passphrase_and_shared_stdin() {
    use dbx_core::persistence::connection_import::read_import_file_with_passphrase;
    use std::{os::unix::fs::PermissionsExt, path::Path};
    let directory = tempfile::tempdir().unwrap();
    let encrypted = directory.path().join("encrypted.json");
    let passphrase = directory.path().join("passphrase.txt");
    std::fs::write(&encrypted, include_bytes!("fixtures/connection_import_encrypted.json")).unwrap();
    std::fs::set_permissions(&encrypted, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&passphrase, b"synthetic-import-passphrase").unwrap();
    std::fs::set_permissions(&passphrase, std::fs::Permissions::from_mode(0o640)).unwrap();
    let error = read_import_file_with_passphrase(&encrypted, false, Some(&passphrase)).unwrap_err();
    assert!(error.starts_with("INSECURE_INPUT:"));
    assert!(!error.contains("synthetic-import-passphrase"));
    let error = read_import_file_with_passphrase(Path::new("-"), true, Some(Path::new("-"))).unwrap_err();
    assert!(error.starts_with("INVALID_CONNECTION_IMPORT:"));
    assert!(read_import_file_with_passphrase(&encrypted, false, Some(Path::new("-"))).is_err());
}
