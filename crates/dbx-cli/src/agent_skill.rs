use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{json_string, CliError, OutputFormat};

const SKILL_NAME: &str = "dbx";
const SKILL_VERSION: &str = "1.1.0";
const STATE_FILE_NAME: &str = ".dbx-managed.json";
const STATE_SCHEMA_VERSION: u8 = 1;

struct EmbeddedFile {
    relative_path: &'static str,
    contents: &'static str,
}

const EMBEDDED_FILES: &[EmbeddedFile] = &[
    EmbeddedFile { relative_path: "SKILL.md", contents: include_str!("../../../skills/dbx/SKILL.md") },
    EmbeddedFile {
        relative_path: "references/commands.md",
        contents: include_str!("../../../skills/dbx/references/commands.md"),
    },
    EmbeddedFile {
        relative_path: "references/safety.md",
        contents: include_str!("../../../skills/dbx/references/safety.md"),
    },
    EmbeddedFile {
        relative_path: "references/workflows.md",
        contents: include_str!("../../../skills/dbx/references/workflows.md"),
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallationStatus {
    NotInstalled,
    UpToDate,
    UpdateAvailable,
    Unmanaged,
    Modified,
}

impl InstallationStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::NotInstalled => "not_installed",
            Self::UpToDate => "up_to_date",
            Self::UpdateAvailable => "update_available",
            Self::Unmanaged => "unmanaged",
            Self::Modified => "modified",
        }
    }
}

#[derive(Debug)]
struct Inspection {
    status: InstallationStatus,
    installed_version: Option<String>,
    managed: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedState {
    schema_version: u8,
    skill_name: String,
    skill_version: String,
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSkillReport {
    action: String,
    status: String,
    skill_name: String,
    bundled_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    managed: bool,
    path: String,
}

pub fn run(args: &[String], format: OutputFormat, skills_dir: Option<&Path>, force: bool) -> Result<String, CliError> {
    if format == OutputFormat::Csv {
        return Err(CliError::new("INVALID_OPTION", "CSV format is not supported for dbx agent commands."));
    }
    if args.len() != 2 {
        return Err(CliError::new("INVALID_ARGUMENT", "Usage: dbx agent <setup|status> [--json]"));
    }

    let root = resolve_skills_dir(skills_dir)?;
    let target = root.join(SKILL_NAME);
    match args[1].as_str() {
        "setup" => setup(&target, force, format),
        "status" => {
            if force {
                return Err(CliError::new("INVALID_OPTION", "--force is only supported by dbx agent setup."));
            }
            let inspection = inspect(&target)?;
            render_report(report("status", &target, inspection), format)
        }
        command => Err(CliError::new(
            "INVALID_ARGUMENT",
            format!("Unknown agent command: {command}. Use dbx agent setup or dbx agent status."),
        )),
    }
}

fn setup(target: &Path, force: bool, format: OutputFormat) -> Result<String, CliError> {
    reject_symlink(target)?;
    let inspection = inspect(target)?;
    let action = match inspection.status {
        InstallationStatus::NotInstalled => "installed",
        InstallationStatus::UpToDate => {
            write_state(target)?;
            "unchanged"
        }
        InstallationStatus::UpdateAvailable => "updated",
        InstallationStatus::Unmanaged | InstallationStatus::Modified if !force => {
            return Err(CliError::new(
                "SKILL_MODIFIED",
                format!(
                    "The DBX Agent Skill at {} is unmanaged or has local changes. Re-run with --force to replace DBX-managed files.",
                    target.display()
                ),
            ));
        }
        InstallationStatus::Unmanaged | InstallationStatus::Modified => "replaced",
    };

    if action != "unchanged" {
        write_embedded_files(target)?;
        write_state(target)?;
    }
    let inspection = inspect(target)?;
    render_report(report(action, target, inspection), format)
}

fn resolve_skills_dir(override_dir: Option<&Path>) -> Result<PathBuf, CliError> {
    if let Some(path) = override_dir {
        return Ok(path.to_path_buf());
    }
    dirs::home_dir()
        .map(|home| home.join(".agents").join("skills"))
        .ok_or_else(|| CliError::new("HOME_NOT_FOUND", "Unable to determine the user home directory."))
}

fn inspect(target: &Path) -> Result<Inspection, CliError> {
    reject_symlink(target)?;
    let skill_path = target.join("SKILL.md");
    let state = read_state(target);
    if !skill_path.exists() {
        let has_other_embedded_files = EMBEDDED_FILES
            .iter()
            .filter(|embedded| embedded.relative_path != "SKILL.md")
            .any(|embedded| target.join(embedded.relative_path).exists());
        return Ok(match state {
            Some(state) => Inspection {
                status: InstallationStatus::Modified,
                installed_version: Some(state.skill_version),
                managed: true,
            },
            None if has_other_embedded_files => {
                Inspection { status: InstallationStatus::Unmanaged, installed_version: None, managed: false }
            }
            None => Inspection { status: InstallationStatus::NotInstalled, installed_version: None, managed: false },
        });
    }
    reject_symlink(&skill_path)?;

    let skill_contents = read_file(&skill_path)?;
    let installed_version =
        state.as_ref().map(|state| state.skill_version.clone()).or_else(|| frontmatter_version(&skill_contents));

    if embedded_files_match(target)? {
        return Ok(Inspection {
            status: InstallationStatus::UpToDate,
            installed_version: Some(SKILL_VERSION.to_string()),
            managed: state.is_some(),
        });
    }

    match state {
        Some(state) if managed_files_unchanged(target, &state)? => {
            Ok(Inspection { status: InstallationStatus::UpdateAvailable, installed_version, managed: true })
        }
        Some(_) => Ok(Inspection { status: InstallationStatus::Modified, installed_version, managed: true }),
        None => Ok(Inspection { status: InstallationStatus::Unmanaged, installed_version, managed: false }),
    }
}

fn embedded_files_match(target: &Path) -> Result<bool, CliError> {
    for embedded in EMBEDDED_FILES {
        let path = safe_join(target, embedded.relative_path)?;
        if !path.exists() {
            return Ok(false);
        }
        reject_symlink(&path)?;
        if read_file(&path)? != embedded.contents {
            return Ok(false);
        }
    }
    Ok(true)
}

fn managed_files_unchanged(target: &Path, state: &ManagedState) -> Result<bool, CliError> {
    if state.schema_version != STATE_SCHEMA_VERSION || state.skill_name != SKILL_NAME {
        return Ok(false);
    }
    for (relative_path, expected_hash) in &state.files {
        let path = safe_join(target, relative_path)?;
        if !path.exists() {
            return Ok(false);
        }
        reject_symlink(&path)?;
        if content_hash(read_file(&path)?.as_bytes()) != *expected_hash {
            return Ok(false);
        }
    }
    for embedded in EMBEDDED_FILES {
        if state.files.contains_key(embedded.relative_path) {
            continue;
        }
        let path = safe_join(target, embedded.relative_path)?;
        if path.exists() {
            reject_symlink(&path)?;
            if read_file(&path)? != embedded.contents {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn write_embedded_files(target: &Path) -> Result<(), CliError> {
    fs::create_dir_all(target).map_err(|error| io_error("SKILL_WRITE_FAILED", target, error))?;
    reject_symlink(target)?;
    for embedded in EMBEDDED_FILES {
        let path = safe_join(target, embedded.relative_path)?;
        reject_symlink(&path)?;
        write_atomic(&path, embedded.contents.as_bytes())?;
    }
    Ok(())
}

fn write_state(target: &Path) -> Result<(), CliError> {
    fs::create_dir_all(target).map_err(|error| io_error("SKILL_WRITE_FAILED", target, error))?;
    let state = bundled_state();
    let contents = serde_json::to_vec_pretty(&state).map_err(|error| CliError::new("ERROR", error.to_string()))?;
    write_atomic(&target.join(STATE_FILE_NAME), &contents)
}

fn bundled_state() -> ManagedState {
    let files = EMBEDDED_FILES
        .iter()
        .map(|embedded| (embedded.relative_path.to_string(), content_hash(embedded.contents.as_bytes())))
        .collect();
    ManagedState {
        schema_version: STATE_SCHEMA_VERSION,
        skill_name: SKILL_NAME.to_string(),
        skill_version: SKILL_VERSION.to_string(),
        files,
    }
}

fn read_state(target: &Path) -> Option<ManagedState> {
    let path = target.join(STATE_FILE_NAME);
    reject_symlink(&path).ok()?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn read_file(path: &Path) -> Result<String, CliError> {
    fs::read_to_string(path).map_err(|error| io_error("SKILL_READ_FAILED", path, error))
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), CliError> {
    reject_symlink(path)?;
    let parent = path.parent().ok_or_else(|| CliError::new("SKILL_WRITE_FAILED", "Skill path has no parent."))?;
    fs::create_dir_all(parent).map_err(|error| io_error("SKILL_WRITE_FAILED", parent, error))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| io_error("SKILL_WRITE_FAILED", parent, error))?;
    temporary
        .write_all(contents)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| io_error("SKILL_WRITE_FAILED", path, error))?;
    temporary.persist(path).map_err(|error| io_error("SKILL_WRITE_FAILED", path, error.error))?;
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CliError::new(
            "SKILL_PATH_UNSAFE",
            format!("Refusing to write through symbolic link {}.", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("SKILL_READ_FAILED", path, error)),
    }
}

fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, CliError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() || relative.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(CliError::new("SKILL_PATH_UNSAFE", "Managed skill metadata contains an unsafe path."));
    }
    Ok(root.join(relative))
}

fn content_hash(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn frontmatter_version(contents: &str) -> Option<String> {
    let mut lines = contents.lines();
    if lines.next()? != "---" {
        return None;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("version:") {
            return Some(value.trim().trim_matches(['\'', '"']).to_string());
        }
    }
    None
}

fn report(action: &str, target: &Path, inspection: Inspection) -> AgentSkillReport {
    AgentSkillReport {
        action: action.to_string(),
        status: inspection.status.as_str().to_string(),
        skill_name: SKILL_NAME.to_string(),
        bundled_version: SKILL_VERSION.to_string(),
        installed_version: inspection.installed_version,
        managed: inspection.managed,
        path: target.display().to_string(),
    }
}

fn render_report(report: AgentSkillReport, format: OutputFormat) -> Result<String, CliError> {
    if format == OutputFormat::Json {
        return json_string(&report);
    }
    Ok(format!(
        "DBX Agent Skill\nAction: {}\nStatus: {}\nBundled version: {}\nInstalled version: {}\nManaged: {}\nPath: {}\n",
        report.action,
        report.status,
        report.bundled_version,
        report.installed_version.as_deref().unwrap_or("not installed"),
        if report.managed { "yes" } else { "no" },
        report.path
    ))
}

fn io_error(code: &'static str, path: &Path, error: std::io::Error) -> CliError {
    CliError::new(code, format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn embedded_skill_version_matches_frontmatter() {
        let main = EMBEDDED_FILES.iter().find(|file| file.relative_path == "SKILL.md").unwrap();
        assert_eq!(frontmatter_version(main.contents).as_deref(), Some(SKILL_VERSION));
    }

    #[test]
    fn embedded_command_reference_covers_the_cli_surface() {
        let commands =
            EMBEDDED_FILES.iter().find(|file| file.relative_path == "references/commands.md").unwrap().contents;
        for command in [
            "dbx doctor",
            "dbx capabilities",
            "dbx agent setup",
            "dbx agent status",
            "dbx connections list",
            "dbx schema list",
            "dbx schema describe",
            "dbx query",
            "dbx context",
            "dbx dbml",
            "dbx docs",
            "dbx open",
        ] {
            assert!(commands.contains(command), "command reference is missing {command}");
        }
    }

    #[test]
    fn setup_installs_and_reports_the_bundled_skill() {
        let directory = tempfile::tempdir().unwrap();
        let output = run(&args(&["agent", "setup"]), OutputFormat::Json, Some(directory.path()), false).unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["action"], "installed");
        assert_eq!(output["status"], "up_to_date");
        assert_eq!(output["bundledVersion"], SKILL_VERSION);
        assert!(directory.path().join("dbx/SKILL.md").exists());
        assert!(directory.path().join("dbx/references/commands.md").exists());
        assert!(directory.path().join(format!("dbx/{STATE_FILE_NAME}")).exists());
    }

    #[test]
    fn repeated_setup_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap();
        let output = run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap();
        assert!(output.contains("Action: unchanged"));
    }

    #[test]
    fn setup_preserves_an_unmanaged_skill_without_force() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("dbx");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "custom skill").unwrap();
        let error = run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap_err();
        assert_eq!(error.code, "SKILL_MODIFIED");
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "custom skill");
    }

    #[test]
    fn force_replaces_managed_paths_but_keeps_extra_files() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("dbx");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "custom skill").unwrap();
        fs::write(target.join("notes.md"), "keep me").unwrap();
        let output = run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), true).unwrap();
        assert!(output.contains("Action: replaced"));
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), EMBEDDED_FILES[0].contents);
        assert_eq!(fs::read_to_string(target.join("notes.md")).unwrap(), "keep me");
    }

    #[test]
    fn status_reports_locally_modified_managed_skill() {
        let directory = tempfile::tempdir().unwrap();
        run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap();
        fs::write(directory.path().join("dbx/SKILL.md"), "edited").unwrap();
        let output = run(&args(&["agent", "status"]), OutputFormat::Json, Some(directory.path()), false).unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["status"], "modified");
        assert_eq!(output["managed"], true);
    }

    #[test]
    fn status_reports_a_managed_update_without_overwriting_it() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("dbx");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "old managed skill").unwrap();
        let mut files = BTreeMap::new();
        files.insert("SKILL.md".to_string(), content_hash(b"old managed skill"));
        let old_state = ManagedState {
            schema_version: STATE_SCHEMA_VERSION,
            skill_name: SKILL_NAME.to_string(),
            skill_version: "1.0.0".to_string(),
            files,
        };
        fs::write(target.join(STATE_FILE_NAME), serde_json::to_vec(&old_state).unwrap()).unwrap();
        let output = run(&args(&["agent", "status"]), OutputFormat::Json, Some(directory.path()), false).unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["status"], "update_available");
        assert_eq!(output["installedVersion"], "1.0.0");
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "old managed skill");
    }

    #[test]
    fn setup_updates_an_unchanged_managed_skill() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("dbx");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "old managed skill").unwrap();
        let mut files = BTreeMap::new();
        files.insert("SKILL.md".to_string(), content_hash(b"old managed skill"));
        let old_state = ManagedState {
            schema_version: STATE_SCHEMA_VERSION,
            skill_name: SKILL_NAME.to_string(),
            skill_version: "1.0.0".to_string(),
            files,
        };
        fs::write(target.join(STATE_FILE_NAME), serde_json::to_vec(&old_state).unwrap()).unwrap();
        let output = run(&args(&["agent", "setup"]), OutputFormat::Json, Some(directory.path()), false).unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["action"], "updated");
        assert_eq!(output["status"], "up_to_date");
        assert_eq!(output["installedVersion"], SKILL_VERSION);
    }

    #[test]
    fn missing_main_file_is_treated_as_a_local_modification() {
        let directory = tempfile::tempdir().unwrap();
        run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap();
        fs::remove_file(directory.path().join("dbx/SKILL.md")).unwrap();
        let error = run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap_err();
        assert_eq!(error.code, "SKILL_MODIFIED");
    }

    #[cfg(unix)]
    #[test]
    fn setup_rejects_a_symlinked_skill_directory() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), directory.path().join("dbx")).unwrap();
        let error = run(&args(&["agent", "setup"]), OutputFormat::Table, Some(directory.path()), false).unwrap_err();
        assert_eq!(error.code, "SKILL_PATH_UNSAFE");
    }
}
