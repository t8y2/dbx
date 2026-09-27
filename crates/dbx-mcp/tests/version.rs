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
