//! Exercise the installed CLI interface without using real connections or credentials.
use dbx_core::{
    persistence::{connection_import::MAX_IMPORT_BYTES, secret_codec::managed_key_path, test_storage},
    storage::McpGlobalPolicy,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

fn fixture() -> Value {
    json!({"connections":[{"id":"source", "name":"CLI import", "db_type":"sqlite",
        "host":"/synthetic/unreachable-fixture.sqlite", "port":0, "username":"", "password":"cli-import-secret",
        "database":null, "read_only":true, "init_script":"cli-script-secret",
        "connection_secrets":{"token":"cli-plugin-secret"}}]})
}

fn protected_file(directory: &Path, name: &str, content: &[u8]) -> PathBuf {
    let path = directory.join(name);
    std::fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}

fn invoke(directory: &Path, path: &Path, confirmed: bool, environment: &[(&str, &str)]) -> Output {
    invoke_with_passphrase(directory, path, confirmed, environment, None)
}

fn invoke_with_passphrase(
    directory: &Path,
    path: &Path,
    confirmed: bool,
    environment: &[(&str, &str)],
    passphrase_file: Option<&Path>,
) -> Output {
    invoke_options(directory, path, confirmed, environment, passphrase_file, false, None)
}

fn invoke_options(
    directory: &Path,
    path: &Path,
    confirmed: bool,
    environment: &[(&str, &str)],
    passphrase_file: Option<&Path>,
    initialize: bool,
    input: Option<&[u8]>,
) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dbx"));
    command.args(["connections", "import", "--file"]).arg(path).arg("--json");
    if confirmed {
        command.arg("--yes");
    }
    if let Some(path) = passphrase_file {
        command.arg("--passphrase-file").arg(path);
    }
    command
        .current_dir(directory)
        .env("HOME", directory)
        .env("XDG_DATA_HOME", directory)
        .env("XDG_CONFIG_HOME", directory.join(".config"))
        .env_remove("APPDATA")
        .env("DBX_DATA_DIR", directory)
        .env("DBX_SECRET_KEY_FILE", managed_key_path(directory))
        .env_remove("DBX_SECRET_KEY")
        .env_remove("DBX_WEB_URL")
        .env_remove("DBX_WEB_PASSWORD")
        .env_remove("DBX_MCP_ALLOW_WRITES")
        .env_remove("DBX_MCP_ALLOW_DANGEROUS_SQL")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_ID")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_IDS")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_NAME")
        .env_remove("DBX_MCP_SCOPE_DATABASE")
        .env_remove("DBX_MCP_SCOPE_SCHEMA")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if initialize {
        command.arg("--initialize").env_remove("DBX_SECRET_KEY_FILE").env_remove("DBUS_SESSION_BUS_ADDRESS");
    }
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    for secret in [
        "cli-import-secret",
        "cli-script-secret",
        "cli-plugin-secret",
        "synthetic-import-passphrase",
        "synthetic-encrypted-password",
        "incorrect-passphrase",
    ] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    }
    output
}

fn report(output: &Output) -> Value {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn cli_import_previews_by_default_and_requires_yes_to_persist() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), "bundle-input.json", fixture().to_string().as_bytes());
    let preview = report(&invoke(directory.path(), &file, false, &[]));
    assert_eq!(preview["dry_run"], true);
    assert_eq!(preview["input_count"], 1);
    assert_eq!(preview["imported_count"], 1);
    assert!(storage.load_connections().await.unwrap().is_empty());
    let imported = report(&invoke(directory.path(), &file, true, &[]));
    assert_eq!(imported["dry_run"], false);
    assert_eq!(imported["imported_count"], 1);
    let saved = storage.load_connections().await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_ne!(saved[0].id, "source");
    assert_eq!(saved[0].password, "cli-import-secret");
    assert!(saved[0].read_only);
    let repeated = report(&invoke(directory.path(), &file, true, &[]));
    assert_eq!(repeated["imported_count"], 0);
    assert_eq!(repeated["skipped_count"], 1);
    assert_eq!(storage.load_connections().await.unwrap(), saved);
}

#[tokio::test]
async fn cli_import_read_only_preview_is_allowed_but_apply_remains_blocked() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: true, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), "bundle-input.json", fixture().to_string().as_bytes());
    assert_eq!(report(&invoke(directory.path(), &file, false, &[]))["dry_run"], true);
    let blocked = invoke(directory.path(), &file, true, &[]);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("MCP_READ_ONLY"));
    assert!(storage.load_connections().await.unwrap().is_empty());
}

#[tokio::test]
async fn cli_import_rejects_invalid_encrypted_and_oversized_files() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let invalid = protected_file(directory.path(), "invalid.json", b"{cli-import-secret}");
    let encrypted = protected_file(
        directory.path(),
        "encrypted.json",
        json!({"format":"dbx-encrypted", "version":1,"data":"cli-import-secret"}).to_string().as_bytes(),
    );
    let oversized = protected_file(directory.path(), "oversized.json", &vec![b' '; MAX_IMPORT_BYTES + 1]);
    for file in [&invalid, &encrypted, &oversized] {
        let result = invoke(directory.path(), file, true, &[]);
        assert!(!result.status.success());
        assert!(storage.load_connections().await.unwrap().is_empty());
    }
    let result = invoke(directory.path(), &encrypted, true, &[]);
    assert!(String::from_utf8_lossy(&result.stderr).contains("IMPORT_PASSPHRASE_REQUIRED"));
}

#[cfg(unix)]
#[tokio::test]
async fn cli_import_rejects_group_readable_input_before_preview_or_apply() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), "bundle-input.json", fixture().to_string().as_bytes());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    for confirmed in [false, true] {
        let result = invoke(directory.path(), &file, confirmed, &[]);
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("INSECURE_INPUT"));
    }
    assert!(storage.load_connections().await.unwrap().is_empty());
}

#[tokio::test]
async fn cli_import_cannot_run_in_web_mode_or_scoped_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), "bundle-input.json", fixture().to_string().as_bytes());
    for environment in [
        vec![("DBX_WEB_URL", "http://127.0.0.1:1")],
        vec![("DBX_MCP_SCOPE_CONNECTION_ID", "scoped")],
        vec![("DBX_MCP_SCOPE_DATABASE", "scoped")],
    ] {
        let result = invoke(directory.path(), &file, true, &environment);
        assert!(!result.status.success());
        assert!(storage.load_connections().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn cli_import_encrypted_bundle_uses_protected_passphrase_file() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let encrypted = protected_file(
        directory.path(),
        "encrypted.json",
        include_bytes!("../../dbx-core/tests/fixtures/connection_import_encrypted.json"),
    );
    let passphrase = protected_file(directory.path(), "passphrase.txt", b"synthetic-import-passphrase\r\n");
    let wrong = protected_file(directory.path(), "wrong-passphrase.txt", b"incorrect-passphrase");
    let failed = invoke_with_passphrase(directory.path(), &encrypted, true, &[], Some(&wrong));
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("IMPORT_DECRYPT_FAILED"));
    assert!(storage.load_connections().await.unwrap().is_empty());
    let preview = report(&invoke_with_passphrase(directory.path(), &encrypted, false, &[], Some(&passphrase)));
    assert_eq!(preview["dry_run"], true);
    assert!(storage.load_connections().await.unwrap().is_empty());
    let applied = report(&invoke_with_passphrase(directory.path(), &encrypted, true, &[], Some(&passphrase)));
    assert_eq!(applied["imported_count"], 1);
    assert_eq!(storage.load_connections().await.unwrap()[0].password, "synthetic-encrypted-password");
}

// The standalone Linux build uses an isolated XDG key file. Never probe a developer's OS keychain.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn explicit_initialization_creates_a_key_only_when_applying_to_an_empty_profile() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let file = protected_file(directory.path(), "bundle-input.json", fixture().to_string().as_bytes());
    let key = directory.path().join(".config/dbx/secret.key");
    let default_apply = invoke(directory.path(), &file, true, &[]);
    assert!(!default_apply.status.success(), "ordinary import must not provision a key");
    assert!(!key.exists());
    let preview = report(&invoke_options(directory.path(), &file, false, &[], None, true, None));
    assert_eq!(preview["dry_run"], true);
    assert!(!key.exists(), "preview must not create encryption-key material");
    let storage = test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
    assert!(storage.load_connections().await.unwrap().is_empty());
    assert!(!key.exists());
    let applied = report(&invoke_options(directory.path(), &file, true, &[], None, true, None));
    assert_eq!(applied["imported_count"], 1);
    assert!(key.exists());
    assert_eq!(std::fs::metadata(&key).unwrap().permissions().mode() & 0o077, 0);
    let key_environment = [("DBX_SECRET_KEY_FILE", key.to_str().unwrap())];
    let saved = report(&invoke(directory.path(), &file, false, &key_environment));
    assert_eq!(saved["skipped_count"], 1);
    assert_eq!(saved["imported_count"], 0);
    for name in ["dbx.db", "dbx.db-wal"] {
        if let Ok(bytes) = std::fs::read(directory.path().join(name)) {
            for secret in [b"cli-import-secret".as_slice(), b"cli-plugin-secret".as_slice()] {
                assert!(
                    !bytes.windows(secret.len()).any(|window| window == secret),
                    "plaintext secret stored in SQLite"
                );
            }
        }
    }
    let key_before = std::fs::read(&key).unwrap();
    let blocked = invoke_options(directory.path(), &file, true, &[], None, true, None);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("CONNECTION_IMPORT_INITIALIZATION_BLOCKED"));
    let still_saved = report(&invoke(directory.path(), &file, false, &key_environment));
    assert_eq!(still_saved["skipped_count"], 1);
    assert_eq!(std::fs::read(&key).unwrap(), key_before);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn explicit_initialization_refuses_legacy_files_without_migrating_them() {
    let directory = tempfile::tempdir().unwrap();
    let file = protected_file(directory.path(), "import.json", fixture().to_string().as_bytes());
    let legacy_bytes = fixture()["connections"].to_string();
    let legacy = protected_file(directory.path(), "connections.json", legacy_bytes.as_bytes());
    let result = invoke_options(directory.path(), &file, true, &[], None, true, None);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("CONNECTION_IMPORT_INITIALIZATION_BLOCKED"));
    assert!(!managed_key_path(directory.path()).exists());
    assert!(!directory.path().join(".config/dbx/secret.key").exists());
    assert_eq!(std::fs::read(&legacy).unwrap(), legacy_bytes.as_bytes());
    let storage = test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
    assert!(storage.load_connections().await.unwrap().is_empty());
}

#[tokio::test]
async fn cli_import_accepts_a_secure_passphrase_pipe_without_putting_it_in_argv() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let encrypted = protected_file(
        directory.path(),
        "encrypted.json",
        include_bytes!("../../dbx-core/tests/fixtures/connection_import_encrypted.json"),
    );
    for confirmed in [false, true] {
        let result = invoke_options(
            directory.path(),
            &encrypted,
            confirmed,
            &[],
            Some(Path::new("-")),
            false,
            Some(b"synthetic-import-passphrase\n"),
        );
        let result = report(&result);
        assert_eq!(result["dry_run"], !confirmed);
        assert_eq!(result["imported_count"], 1);
        assert_eq!(storage.load_connections().await.unwrap().len(), usize::from(confirmed));
    }
    assert_eq!(storage.load_connections().await.unwrap()[0].password, "synthetic-encrypted-password");
}
