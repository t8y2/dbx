use super::{canonical_directory, executable_name, sdk_root_from_environment, value_after, ProjectConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DevConfig {
    #[serde(default)]
    ui_build: Vec<String>,
    #[serde(default)]
    ui_watch: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct Options {
    path: PathBuf,
    port: u16,
    data_dir: Option<PathBuf>,
}

fn parse(arguments: &[String]) -> Result<Options, String> {
    let mut options = Options { path: PathBuf::from("."), port: 5190, data_dir: None };
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--path" => options.path = PathBuf::from(value_after(arguments, &mut index)?),
            "--port" => {
                options.port =
                    value_after(arguments, &mut index)?.parse().map_err(|_| "--port must be between 0 and 65535")?
            }
            "--data-dir" => options.data_dir = Some(PathBuf::from(value_after(arguments, &mut index)?)),
            other => return Err(format!("Unknown dev argument '{other}'")),
        }
        index += 1;
    }
    Ok(options)
}

fn relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.components().any(|p| !matches!(p, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Expected a project-relative path: {}", path.display()));
    }
    Ok(())
}

fn build_config(options: &Options, sdk_root: Option<&Path>) -> Result<Value, String> {
    let project = canonical_directory(&options.path)?;
    let config: ProjectConfig = toml::from_str(
        &fs::read_to_string(project.join("dbx-plugin.toml"))
            .map_err(|e| format!("Cannot read dbx-plugin.toml: {e}"))?,
    )
    .map_err(|e| format!("Invalid dbx-plugin.toml: {e}"))?;
    if config.schema_version != 1 {
        return Err("Unsupported project configuration version".into());
    }
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(project.join("manifest.json")).map_err(|e| format!("Cannot read manifest.json: {e}"))?,
    )
    .map_err(|e| format!("Invalid manifest.json: {e}"))?;
    let entry =
        manifest.pointer("/entrypoints/ui/entry").and_then(Value::as_str).ok_or("dev requires a UI entrypoint")?;
    relative_path(Path::new(entry))?;
    let ui_root = manifest.pointer("/entrypoints/ui/root").and_then(Value::as_str).unwrap_or("ui");
    relative_path(Path::new(ui_root))?;
    if !Path::new(entry).starts_with(ui_root) {
        return Err("UI entry must be inside its declared root".into());
    }
    for command in [&config.dev.ui_build, &config.dev.ui_watch] {
        if command.first().is_some_and(|c| c.trim().is_empty()) {
            return Err("dev build commands must start with an executable".into());
        }
    }
    let data_dir = match &options.data_dir {
        Some(path) if path.is_absolute() => path.clone(),
        Some(path) => project.join(path),
        None => project.join(".dbx-dev"),
    };
    let mut launch = json!({"project": project, "dataDir": data_dir, "port": options.port,
        "commands": {"ui": config.dev.ui_build, "watch": config.dev.ui_watch}});
    let declared_backend = manifest.pointer("/entrypoints/backend").is_some_and(|v| !v.is_null());
    if let Some(backend) = config.backend {
        if !declared_backend {
            return Err("Project declares a backend but manifest does not".into());
        }
        relative_path(&backend.directory)?;
        if backend.binary.is_empty()
            || matches!(backend.binary.as_str(), "." | "..")
            || backend.binary.contains(['/', '\\'])
        {
            return Err("Backend binary must be a filename".into());
        }
        let directory = project.join(&backend.directory);
        launch["backendWatch"] = json!(directory);
        let (binary, command) = match backend.language.as_str() {
            "rust" => {
                let cargo_manifest = directory.join("Cargo.toml");
                let cargo: toml::Value = toml::from_str(
                    &fs::read_to_string(&cargo_manifest).map_err(|e| format!("Cannot read backend Cargo.toml: {e}"))?,
                )
                .map_err(|e| format!("Invalid backend Cargo.toml: {e}"))?;
                let target = data_dir.join("rust-target");
                let mut args = vec![
                    "build".to_string(),
                    "--manifest-path".into(),
                    cargo_manifest.to_string_lossy().into_owned(),
                    "--target-dir".into(),
                    target.to_string_lossy().into_owned(),
                ];
                if directory.join("Cargo.lock").is_file() {
                    args.push("--locked".into());
                }
                // A crates.io patch is inappropriate for explicitly pinned Git or path dependencies.
                let dependency = cargo.get("dependencies").and_then(|d| d.get("dbx-plugin-sdk"));
                let explicit_source = dependency.is_some_and(|d| d.get("git").is_some() || d.get("path").is_some());
                if let Some(root) = sdk_root.filter(|_| dependency.is_some() && !explicit_source) {
                    let sdk = root.join("plugins/sdk/rust/dbx-plugin-sdk");
                    if !sdk.join("Cargo.toml").is_file() {
                        return Err("Rust SDK root is invalid".into());
                    }
                    args.extend([
                        "--config".into(),
                        format!(
                            "patch.crates-io.dbx-plugin-sdk.path={}",
                            serde_json::to_string(&sdk.to_string_lossy()).map_err(|e| e.to_string())?
                        ),
                    ]);
                }
                (
                    target.join("debug").join(executable_name(&backend.binary)),
                    json!({"command":"cargo", "args":args, "cwd":project}),
                )
            }
            "go" => {
                if !directory.join("go.mod").is_file() {
                    return Err("Go backend is missing go.mod".into());
                }
                let binary = data_dir.join("bin").join(executable_name(&backend.binary));
                let mut command = json!({"command":"go", "args":["build","-trimpath","-o",binary,"."],"cwd":directory});
                if let Some(root) = sdk_root {
                    let sdk = root.join("plugins/sdk/go/dbx-plugin-sdk");
                    if !sdk.join("go.mod").is_file() {
                        return Err("Go SDK root is invalid".into());
                    }
                    // The runtime materializes this workfile inside its private data directory.
                    command["goWorkspace"] = json!([directory, sdk]);
                }
                (binary, command)
            }
            _ => return Err("dev supports Rust and Go backends".into()),
        };
        launch["backend"] = json!(binary);
        launch["commands"]["backend"] = command;
    } else if declared_backend {
        return Err("Manifest backend requires [backend] configuration".into());
    }
    Ok(launch)
}

pub(super) fn run(arguments: Vec<String>) -> Result<(), String> {
    if arguments.iter().any(|a| a == "--help" || a == "-h") {
        println!("Run a plugin without starting DBX (Node.js 22+)\n\nUsage: dbx-plugin dev [--path DIR] [--port PORT] [--data-dir DIR]\n\n  --path DIR      Plugin project (default: current directory)\n  --port PORT     Loopback port (default: 5190; occupied ports fall back to a free port)\n  --data-dir DIR  Development data (default: <project>/.dbx-dev)\n\nOptional [dev] ui_build and ui_watch arrays configure UI commands.\nDevelopment credentials are stored locally as plaintext.\nDBX_PLUGIN_DEV_RUNTIME overrides the runtime entrypoint; DBX_PLUGIN_NODE selects Node.");
        return Ok(());
    }
    let options = parse(&arguments)?;
    let sdk_root = sdk_root_from_environment()?;
    let launch = build_config(&options, sdk_root.as_deref())?;
    let runtime = std::env::var_os("DBX_PLUGIN_DEV_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev-host/dist/runtime.mjs"));
    if !runtime.is_file() {
        return Err("Development runtime is missing. Install @dbx-app/plugin-cli, or run 'npm ci --prefix plugins/sdk/dev-host && npm run build --prefix plugins/sdk/dev-host' in a DBX checkout and set DBX_PLUGIN_DEV_RUNTIME to dist/runtime.mjs.".into());
    }
    let node = std::env::var_os("DBX_PLUGIN_NODE").unwrap_or_else(|| "node".into());
    let version = Command::new(&node)
        .arg("--version")
        .output()
        .map_err(|_| "dev requires Node.js 22+; install Node or set DBX_PLUGIN_NODE")?;
    let major = String::from_utf8_lossy(&version.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|v| v.parse::<u32>().ok());
    if !version.status.success() || !major.is_some_and(|v| v >= 22) {
        return Err("dev requires Node.js 22+".into());
    }
    let mut command = Command::new(node);
    command.arg(runtime).arg("--config").arg(serde_json::to_string(&launch).map_err(|e| e.to_string())?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(format!("Cannot launch development runtime: {}", command.exec()))
    }
    #[cfg(not(unix))]
    {
        let status = command.status().map_err(|e| format!("Cannot launch development runtime: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Development runtime exited with {status}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn options_and_invalid_arguments() {
        assert_eq!(parse(&[]).unwrap(), Options { path: ".".into(), port: 5190, data_dir: None });
        assert_eq!(parse(&["--port".into(), "0".into(), "--path".into(), "space path".into()]).unwrap().port, 0);
        for args in [vec!["--port", "65536"], vec!["--port", "no"], vec!["--path"], vec!["--unknown"]] {
            assert!(parse(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
    }
    #[test]
    fn frontend_needs_no_backend_and_dev_arrays_are_typed() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("manifest.json"), r#"{"entrypoints":{"ui":{"root":"ui","entry":"ui/index.html"}}}"#)
            .unwrap();
        fs::write(
            root.path().join("dbx-plugin.toml"),
            "schema_version=1\n[package]\ninclude=[\"ui\"]\n[dev]\nui_build=[\"npm\",\"run\",\"build\"]\n",
        )
        .unwrap();
        let options = Options { path: root.path().into(), port: 5190, data_dir: None };
        let config = build_config(&options, None).unwrap();
        assert!(config.get("backend").is_none());
        assert_eq!(config["commands"]["ui"][0], "npm");
        fs::write(
            root.path().join("dbx-plugin.toml"),
            "schema_version=1\n[package]\ninclude=[]\n[dev]\nui_build=\"npm run build\"\n",
        )
        .unwrap();
        assert!(build_config(&options, None).is_err());
    }
    #[test]
    fn paths_cannot_escape_project() {
        for path in ["../ui", "/tmp/ui", ""] {
            assert!(relative_path(Path::new(path)).is_err());
        }
        assert!(relative_path(Path::new("ui/index.html")).is_ok());
    }
}
