//! Connection configuration commands. Never accept inline JSON or secret flags in argv.
use std::{
    io::{IsTerminal, Read},
    path::Path,
};

use dbx_core::{
    database_manifest,
    mcp_policy::policy_allows_connection,
    persistence::connection_management::{
        connection_details, safe_connection_error, safe_connection_text, validate_connection_patch,
    },
};
use dbx_mcp::backend::{new_connection_config, parse_database_type};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    ensure_arg_count, format_connections, json_string, CliError, ConnectionConfig, DbxBackend, Flags, OutputFormat,
};

// Intentionally does not derive Debug: this object contains credentials.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddInput {
    name: String,
    db_type: String,
    host: String,
    port: Option<u16>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    database: Option<String>,
    #[serde(default)]
    ssl: bool,
    driver_profile: Option<String>,
    #[serde(default)]
    read_only: bool,
    #[serde(default = "default_save_password")]
    save_password: bool,
}
fn default_save_password() -> bool {
    true
}

fn management_error(message: String) -> CliError {
    let message = safe_connection_error(&message);
    for code in [
        "MCP_READ_ONLY",
        "CONNECTION_OUT_OF_SCOPE",
        "CONNECTION_NOT_FOUND",
        "CONNECTION_ALREADY_EXISTS",
        "INVALID_CONNECTION",
        "MCP_POLICY_UNAVAILABLE",
    ] {
        if message.starts_with(&format!("{code}:")) {
            return CliError::new(code, safe_connection_text(&message));
        }
    }
    CliError::new("CONNECTION_STORE_ERROR", safe_connection_text(&message))
}

fn read_input(path: &Path) -> Result<Value, CliError> {
    let mut data = String::new();
    if path == Path::new("-") {
        let stdin = std::io::stdin();
        if stdin.is_terminal() {
            return Err(CliError::new("INVALID_INPUT", "Do not type credentials into an echoing terminal. Pipe JSON from a secure credential tool or use an owner-only JSON file."));
        }
        stdin
            .take(1024 * 1024 + 1)
            .read_to_string(&mut data)
            .map_err(|_| CliError::new("INVALID_INPUT", "Could not read JSON from stdin."))?;
    } else {
        let file = std::fs::File::open(path)
            .map_err(|_| CliError::new("INVALID_INPUT", "Could not open the connection JSON file."))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Enforce before reading: even malformed documents can contain credentials.
            if file
                .metadata()
                .map_err(|_| CliError::new("INVALID_INPUT", "Could not inspect connection JSON file permissions."))?
                .permissions()
                .mode()
                & 0o077
                != 0
            {
                return Err(CliError::new(
                    "INSECURE_INPUT",
                    "Connection JSON files must be owner-only (chmod 600). Alternatively pipe JSON with --file -.",
                ));
            }
        }
        file.take(1024 * 1024 + 1)
            .read_to_string(&mut data)
            .map_err(|_| CliError::new("INVALID_INPUT", "Could not read the connection JSON file."))?;
    }
    if data.len() > 1024 * 1024 {
        return Err(CliError::new("INVALID_INPUT", "Connection JSON must not exceed 1 MiB."));
    }
    // serde errors can include offending values; never print them for credential-bearing input.
    serde_json::from_str(&data).map_err(|_| CliError::new("INVALID_INPUT", "Expected a valid JSON object."))
}

async fn allowed_connections(backend: &dyn DbxBackend) -> Result<Vec<ConnectionConfig>, CliError> {
    let policy = backend.load_mcp_global_policy().await.map_err(management_error)?;
    let groups = backend.load_connection_group_details().await.map_err(management_error)?;
    let scope = dbx_mcp::McpScope::from_env();
    Ok(backend
        .load_connections()
        .await
        .map_err(management_error)?
        .into_iter()
        .filter(|config| policy_allows_connection(&policy, groups.get(&config.id), &config.id))
        .filter(|config| {
            if !scope.connection_ids.is_empty() {
                scope.connection_ids.contains(&config.id)
            } else {
                scope.connection_name.as_ref().is_none_or(|name| name == &config.name)
            }
        })
        .collect())
}

fn select(connections: Vec<ConnectionConfig>, selector: &str) -> Result<ConnectionConfig, CliError> {
    if let Some(config) = connections.iter().find(|config| config.id == selector) {
        return Ok(config.clone());
    }
    let mut matching = connections.into_iter().filter(|config| config.name.eq_ignore_ascii_case(selector));
    let first = matching
        .next()
        .ok_or_else(|| CliError::new("CONNECTION_NOT_FOUND", "Connection was not found or is outside MCP scope."))?;
    if matching.next().is_some() {
        return Err(CliError::new(
            "AMBIGUOUS_CONNECTION",
            "Multiple connections have this name. Use the connection ID.",
        ));
    }
    Ok(first)
}

fn details(config: &ConnectionConfig, format: OutputFormat) -> Result<String, CliError> {
    let value = connection_details(config);
    match format {
        OutputFormat::Json => json_string(&value),
        OutputFormat::Table => {
            let rows = value
                .as_object()
                .expect("projection object")
                .iter()
                .map(|(key, value)| json!({"setting": key, "value": value}))
                .collect::<Vec<_>>();
            Ok(format!("{}\n", super::markdown_table(&["Setting", "Value"], &rows, &["setting", "value"])))
        }
        OutputFormat::Csv => {
            Err(CliError::new("INVALID_OPTION", "Use --json for connection details or mutation results."))
        }
    }
}

pub(super) async fn run(backend: &dyn DbxBackend, flags: &Flags) -> Result<String, CliError> {
    let command = flags.args.get(1).map(String::as_str).unwrap_or("");
    let policy = backend.load_mcp_global_policy().await.map_err(management_error)?;
    let tool = match command {
        "list" => "dbx_list_connections",
        "get" => "dbx_get_connection",
        "add" => "dbx_add_connection",
        "update" => "dbx_update_connection",
        "remove" => "dbx_remove_connection",
        _ => "",
    };
    if policy.allowed_tool_names.as_ref().is_some_and(|names| !names.iter().any(|name| name == tool)) {
        return Err(CliError::new("TOOL_OUT_OF_SCOPE", "This connection command is not allowed by DBX MCP settings."));
    }
    if flags.schema.is_some()
        || flags.database.is_some()
        || !flags.tables.is_empty()
        || flags.max_tables.is_some()
        || flags.max_rows.is_some()
        || flags.timeout_ms.is_some()
        || flags.out.is_some()
        || flags.notes.is_some()
        || flags.lang.is_some()
        || flags.allow_writes
        || flags.allow_dangerous
    {
        return Err(CliError::new(
            "INVALID_OPTION",
            "Connection commands accept --json/--format, --file for add/update, and --yes for remove.",
        ));
    }
    if flags.yes && command != "remove" {
        return Err(CliError::new("INVALID_OPTION", "--yes is only supported by connections remove."));
    }
    if flags.file.is_some() && !matches!(command, "add" | "update") {
        return Err(CliError::new("INVALID_OPTION", "--file is only supported by connections add/update."));
    }
    if command == "list" {
        ensure_arg_count(&flags.args, 2, "dbx connections list")?;
        return format_connections(&allowed_connections(backend).await?, flags.format);
    }
    if command == "get" {
        ensure_arg_count(&flags.args, 3, "dbx connections get")?;
        return details(&select(allowed_connections(backend).await?, &flags.args[2])?, flags.format);
    }
    if !matches!(command, "add" | "update" | "remove") {
        return Err(CliError::new("USAGE", super::usage()));
    }
    ensure_arg_count(&flags.args, if command == "add" { 2 } else { 3 }, "dbx connections")?;
    let scope = dbx_mcp::McpScope::from_env();
    if !scope.connection_ids.is_empty()
        || scope.connection_name.is_some()
        || scope.database.is_some()
        || scope.schema.is_some()
    {
        return Err(CliError::new("CONNECTION_OUT_OF_SCOPE", "Connection management is disabled in scoped sessions."));
    }

    if flags.format == OutputFormat::Csv {
        return Err(CliError::new("INVALID_OPTION", "Use --json for connection mutation results."));
    }
    let policy = backend.load_mcp_global_policy().await.map_err(management_error)?;
    if policy.read_only {
        return Err(CliError::new(
            "MCP_READ_ONLY",
            "DBX global MCP read-only mode is enabled. Change its settings in DBX before managing connections.",
        ));
    }
    if command == "add" || command == "update" {
        let path = flags.file.as_deref().ok_or_else(|| CliError::new("INVALID_INPUT", "Provide --file <owner-only.json> or --file - for JSON stdin. Credentials must never be passed as command-line arguments."))?;
        let input = read_input(path)?;
        let config = if command == "add" {
            let request: AddInput = serde_json::from_value(input).map_err(|_| CliError::new("INVALID_CONNECTION", "Invalid connection object. Required: name, db_type, host. Unknown fields or invalid types are not accepted."))?;
            validate_connection_patch(&json!({"name":request.name, "host":request.host})).map_err(management_error)?;
            let db_type = parse_database_type(&request.db_type)
                .map_err(|_| CliError::new("INVALID_CONNECTION_TYPE", "Unsupported database type."))?;
            let port = request.port.or_else(|| database_manifest::default_port(&db_type)).ok_or_else(|| {
                CliError::new(
                    "INVALID_CONNECTION",
                    "A port is required for this database type; use 0 for a file-based database.",
                )
            })?;
            let mut config = new_connection_config(
                uuid::Uuid::new_v4().to_string(),
                request.name.trim().to_owned(),
                db_type,
                request.host,
                port,
                request.username,
                request.password,
                request.database,
                request.ssl,
                request.driver_profile,
            )
            .map_err(|_| CliError::new("INVALID_CONNECTION", "Invalid connection settings."))?;
            config.read_only = request.read_only;
            config.save_password = request.save_password;
            backend.add_connection_for_mcp(config).await.map_err(management_error)?
        } else {
            validate_connection_patch(&input).map_err(management_error)?;
            let config = select(allowed_connections(backend).await?, &flags.args[2])?;
            backend.update_connection_for_mcp(&config.id, input).await.map_err(management_error)?
        };
        return details(&config, flags.format);
    }
    let config = select(allowed_connections(backend).await?, &flags.args[2])?;
    if !flags.yes {
        return Err(CliError::new("CONFIRMATION_REQUIRED", format!("Removing saved connection {} deletes its stored credentials and cannot be undone. Database contents are unaffected. Review with connections get, then repeat with --yes to confirm.", safe_connection_text(&config.id))));
    }
    if !backend.remove_connection_for_mcp(&config.id).await.map_err(management_error)? {
        return Err(CliError::new("CONNECTION_NOT_FOUND", "Connection was already removed."));
    }
    if flags.format == OutputFormat::Json {
        json_string(&json!({"removed": true, "id": safe_connection_text(&config.id)}))
    } else {
        Ok(format!("Removed saved connection {}\n", safe_connection_text(&config.id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::{connection::AppState, persistence::test_storage, storage::McpGlobalPolicy};
    use dbx_mcp::LocalBackend;
    use std::sync::Arc;

    fn fixture_file(directory: &Path, name: &str, value: Value) -> std::path::PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, value.to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }
    async fn invoke(backend: &dyn DbxBackend, args: &[&str]) -> Result<String, CliError> {
        let flags = super::super::parse_flags(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())?;
        super::super::run_with_backend(backend, flags).await
    }

    #[tokio::test]
    async fn cli_connection_crud_uses_real_isolated_storage() {
        let directory = tempfile::tempdir().unwrap();
        let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
        storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
        let backend = LocalBackend::from_app_state(
            Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
                storage.clone(),
                directory.path().join("plugins"),
                directory.path().join("agents"),
                "",
            )),
            directory.path().to_path_buf(),
        );
        let input = fixture_file(
            directory.path(),
            "input.json",
            json!({"name":"Fixture", "db_type":"sqlite", "host":":memory:", "port":0, "password":"fixture-secret", "read_only":true}),
        );
        let result =
            invoke(&backend, &["connections", "add", "--file", input.to_str().unwrap(), "--json"]).await.unwrap();
        assert!(!result.contains("fixture-secret"));
        let added: Value = serde_json::from_str(&result).unwrap();
        let id = added["id"].as_str().unwrap();
        assert!(added["read_only"].as_bool().unwrap());
        assert_eq!(storage.load_connections().await.unwrap()[0].password, "fixture-secret");
        assert_eq!(
            invoke(&backend, &["connections", "add", "--file", input.to_str().unwrap()]).await.unwrap_err().code,
            "CONNECTION_ALREADY_EXISTS"
        );
        for format in ["json", "table", "csv"] {
            let listed = invoke(&backend, &["connections", "list", "--format", format]).await.unwrap();
            assert!(listed.contains(id));
            assert!(!listed.contains("fixture-secret"));
        }
        let patch = fixture_file(directory.path(), "patch.json", json!({"name":"Renamed", "read_only":false}));
        invoke(&backend, &["connections", "update", id, "--file", patch.to_str().unwrap(), "--json"]).await.unwrap();
        let result = invoke(&backend, &["connections", "get", "Renamed", "--json"]).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["read_only"], false);
        assert!(!result.contains("fixture-secret"));
        assert_eq!(storage.load_connections().await.unwrap()[0].password, "fixture-secret");
        assert_eq!(invoke(&backend, &["connections", "remove", id]).await.unwrap_err().code, "CONFIRMATION_REQUIRED");
        assert_eq!(storage.load_connections().await.unwrap().len(), 1);
        storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: true, ..Default::default() }).await.unwrap();
        assert_eq!(
            invoke(&backend, &["connections", "update", id, "--file", patch.to_str().unwrap()]).await.unwrap_err().code,
            "MCP_READ_ONLY"
        );
        assert_eq!(invoke(&backend, &["connections", "remove", id, "--yes"]).await.unwrap_err().code, "MCP_READ_ONLY");
        storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
        invoke(&backend, &["connections", "remove", id, "--yes", "--json"]).await.unwrap();
        assert!(storage.load_connections().await.unwrap().is_empty());
        assert_eq!(invoke(&backend, &["connections", "get", id]).await.unwrap_err().code, "CONNECTION_NOT_FOUND");
    }

    #[test]
    fn ambiguous_names_require_an_id() {
        let make = |id: &str| {
            new_connection_config(
                id.into(),
                "Duplicate".into(),
                dbx_core::models::connection::DatabaseType::Sqlite,
                ":memory:".into(),
                0,
                String::new(),
                String::new(),
                None,
                false,
                None,
            )
            .unwrap()
        };
        let configs = vec![make("one"), make("two")];
        assert_eq!(select(configs.clone(), "duplicate").unwrap_err().code, "AMBIGUOUS_CONNECTION");
        assert_eq!(select(configs, "two").unwrap().id, "two");
    }

    #[test]
    fn credential_input_validation_does_not_echo_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let path = fixture_file(directory.path(), "invalid.json", json!({}));
        std::fs::write(&path, "{\"password\":oops-secret").unwrap();
        assert!(!read_input(&path).unwrap_err().message.contains("oops-secret"));
        let error = super::super::parse_flags(&["connections".into(), "add".into(), "--password=argv-secret".into()])
            .unwrap_err();
        assert!(!error.message.contains("argv-secret"));
        assert!(super::super::parse_flags(&["connections".into(), "add".into(), "--file".into(), "-".into()]).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(read_input(&path).unwrap_err().code, "INSECURE_INPUT");
        }
    }
}
