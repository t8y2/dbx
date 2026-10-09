#[test]
fn version_exits_without_initializing_storage_or_transport() {
    let directory = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mcp"))
        .arg("--version")
        .env("DBX_DATA_DIR", directory.path().join("must-not-exist"))
        .env("DBX_WEB_URL", "not a URL")
        .env("DBX_MCP_TRANSPORT", "invalid")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), format!("dbx-mcp {}\n", env!("CARGO_PKG_VERSION")));
    assert!(output.stderr.is_empty());
    assert!(!directory.path().join("must-not-exist").exists());
}

#[test]
fn keychain_authorization_rejects_extra_arguments_without_opening_storage() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("must-not-exist");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mcp"))
        .args(["--authorize-keychain", "--transport", "stdio"])
        .env("DBX_DATA_DIR", &data_dir)
        .env("DBX_WEB_URL", "not a URL")
        .env("DBX_MCP_TRANSPORT", "invalid")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage: dbx-mcp --authorize-keychain"));
    assert!(!data_dir.exists());
}

#[test]
fn keychain_authorization_rejects_untrusted_or_unsupported_builds_before_storage() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("must-not-exist");
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mcp"));
    #[cfg(all(target_os = "macos", feature = "os-keyring"))]
    let log = intercept_keychain(&mut command, directory.path());
    let output = command
        .arg("--authorize-keychain")
        .env("DBX_DATA_DIR", &data_dir)
        .env("DBX_WEB_URL", "not a URL")
        .env("DBX_MCP_TRANSPORT", "invalid")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8_lossy(&output.stderr);
    if cfg!(all(target_os = "macos", feature = "os-keyring")) {
        assert!(error.contains("KEYCHAIN_AUTHORIZATION_UNTRUSTED"), "{error}");
    } else {
        assert!(error.contains("KEYCHAIN_AUTHORIZATION_UNSUPPORTED"), "{error}");
    }
    assert!(!data_dir.exists());
    #[cfg(all(target_os = "macos", feature = "os-keyring"))]
    assert!(!log.exists(), "untrusted recovery must not query the Keychain");
}

#[cfg(all(target_os = "macos", feature = "os-keyring"))]
fn intercept_keychain(command: &mut std::process::Command, directory: &std::path::Path) -> std::path::PathBuf {
    let library = directory.join("keychain-policy.dylib");
    let log = directory.join("keychain-policy.log");
    let build = std::process::Command::new("/usr/bin/clang")
        .args(["-dynamiclib", "-Wno-deprecated-declarations", "-framework", "Security", "-o"])
        .arg(&library)
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/macos-keychain-policy.c"))
        .output()
        .unwrap();
    assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
    command.env("DYLD_INSERT_LIBRARIES", &library).env("DBX_TEST_KEYCHAIN_POLICY_LOG", &log);
    log
}

#[cfg(all(target_os = "macos", feature = "os-keyring"))]
#[test]
fn background_keychain_denial_is_noninteractive_and_never_provisions_a_key() {
    let directory = tempfile::tempdir().unwrap();
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mcp"));
    let log = intercept_keychain(&mut command, directory.path());
    let output = command
        .env("HOME", directory.path())
        .env("DBX_DATA_DIR", directory.path().join("data"))
        .env_remove("DBX_WEB_URL")
        .env_remove("DBX_SECRET_KEY")
        .env_remove("DBX_SECRET_KEY_FILE")
        .env_remove("DBX_MCP_TRANSPORT")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let reads = std::fs::read_to_string(&log).unwrap_or_else(|error| {
        panic!(
            "the child must probe the intercepted credential provider: {error}; {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert!(reads.contains("lookup interaction=0"), "{reads}");
    assert!(!reads.contains("interaction=1"), "{reads}");
    assert!(!reads.contains("write"), "{reads}");
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("KEYRING_ACCESS_FAILED"), "{error}");
    assert!(error.contains("--authorize-keychain"), "{error}");
    assert!(!directory.path().join(".dbx/secret.key").exists());
}
