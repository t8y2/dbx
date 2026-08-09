use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fmt::Display;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, IsTerminal, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;
use serde_json::Value;

const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");
const SDK_VERSION: &str = "0.1.0";
const ANSI_RESET: &str = "\x1b[0m";
const ANSI_ACCENT: &str = "1;35";
const ANSI_PROMPT: &str = "1;36";
const ANSI_SUCCESS: &str = "1;32";
const ANSI_WARNING: &str = "1;33";
const ANSI_ERROR: &str = "1;31";
const ANSI_MUTED: &str = "2";

fn color_enabled_with(
    is_terminal: bool,
    no_color: bool,
    term: Option<&str>,
    clicolor: Option<&str>,
    clicolor_force: Option<&str>,
) -> bool {
    if no_color {
        return false;
    }
    if clicolor_force.is_some_and(|value| !value.is_empty() && value != "0") {
        return true;
    }
    if clicolor == Some("0") || term.is_some_and(|value| value.eq_ignore_ascii_case("dumb")) {
        return false;
    }
    is_terminal
}

fn terminal_colors_enabled(is_terminal: bool) -> bool {
    let term = std::env::var("TERM").ok();
    let clicolor = std::env::var("CLICOLOR").ok();
    let clicolor_force = std::env::var("CLICOLOR_FORCE").ok();
    color_enabled_with(
        is_terminal,
        std::env::var_os("NO_COLOR").is_some(),
        term.as_deref(),
        clicolor.as_deref(),
        clicolor_force.as_deref(),
    )
}

fn styled(value: impl Display, code: &str, enabled: bool) -> String {
    if enabled {
        format!("\x1b[{code}m{value}{ANSI_RESET}")
    } else {
        value.to_string()
    }
}

fn styled_stdout(value: impl Display, code: &str) -> String {
    styled(value, code, terminal_colors_enabled(io::stdout().is_terminal()))
}

fn styled_stderr(value: impl Display, code: &str) -> String {
    styled(value, code, terminal_colors_enabled(io::stderr().is_terminal()))
}

pub fn print_error(error: &str) {
    eprintln!("{} {error}", styled_stderr("error:", ANSI_ERROR));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendLanguage {
    Rust,
    Go,
}

impl BackendLanguage {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "rust" => Ok(Self::Rust),
            "go" | "golang" => Ok(Self::Go),
            _ => Err("Backend language must be 'rust' or 'go'".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Go => "go",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Rust => "Rust",
            Self::Go => "Go",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectTemplate {
    Frontend,
    Rust,
    Go,
}

impl ProjectTemplate {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "frontend" | "frontend-only" | "ui" | "none" => Ok(Self::Frontend),
            "rust" => Ok(Self::Rust),
            "go" | "golang" => Ok(Self::Go),
            _ => Err("Plugin template must be 'frontend', 'rust', or 'go'".to_string()),
        }
    }

    fn from_language(language: BackendLanguage) -> Self {
        match language {
            BackendLanguage::Rust => Self::Rust,
            BackendLanguage::Go => Self::Go,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Frontend => "frontend",
            Self::Rust => "rust",
            Self::Go => "go",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Frontend => "Frontend only (universal)",
            Self::Rust => "Rust + frontend",
            Self::Go => "Go + frontend",
        }
    }

    fn backend_language(self) -> Option<BackendLanguage> {
        match self {
            Self::Frontend => None,
            Self::Rust => Some(BackendLanguage::Rust),
            Self::Go => Some(BackendLanguage::Go),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CreateOptions {
    pub directory: PathBuf,
    pub template: ProjectTemplate,
    pub plugin_id: String,
    pub name: String,
    pub publisher: String,
    pub description: String,
    pub version: String,
    pub sdk_root: Option<PathBuf>,
    pub force: bool,
}

#[derive(Debug, Default)]
struct CreateInputs {
    directory: Option<PathBuf>,
    template: Option<ProjectTemplate>,
    plugin_id: Option<String>,
    name: Option<String>,
    publisher: Option<String>,
    description: Option<String>,
    version: Option<String>,
    sdk_root: Option<PathBuf>,
    force: bool,
    yes: bool,
}

#[derive(Debug, Clone)]
pub struct PackageOptions {
    pub project: PathBuf,
    pub target: Option<String>,
    pub output_directory: Option<PathBuf>,
    pub artifact_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectConfig {
    schema_version: u32,
    #[serde(default)]
    backend: Option<BackendConfig>,
    package: PackageConfig,
}

#[derive(Debug, Deserialize)]
struct BackendConfig {
    language: String,
    directory: PathBuf,
    binary: String,
}

#[derive(Debug, Deserialize)]
struct PackageConfig {
    include: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct ManifestIdentity {
    manifest_version: u32,
    id: String,
    version: String,
    #[serde(default)]
    entrypoints: ManifestEntrypoints,
}

#[derive(Debug, Default, Deserialize)]
struct ManifestEntrypoints {
    backend: Option<serde_json::Value>,
}

struct TemplateFile {
    path: &'static str,
    content: &'static str,
}

struct CleanupDirectory {
    path: PathBuf,
}

impl CleanupDirectory {
    fn prepare(path: PathBuf) -> Result<Self, String> {
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|error| format!("Failed to clean {}: {error}", path.display()))?;
        }
        fs::create_dir_all(&path).map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CleanupDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

const SHARED_TEMPLATES: &[TemplateFile] = &[
    TemplateFile { path: ".gitignore", content: include_str!("../templates/common/gitignore") },
    TemplateFile { path: "assets/plugin.svg", content: include_str!("../templates/common/assets/plugin.svg") },
];

const FRONTEND_TEMPLATES: &[TemplateFile] = &[
    TemplateFile { path: "dbx-plugin.toml", content: include_str!("../templates/frontend/dbx-plugin.toml") },
    TemplateFile { path: "manifest.json", content: include_str!("../templates/frontend/manifest.json") },
    TemplateFile { path: "README.md", content: include_str!("../templates/frontend/README.md") },
    TemplateFile { path: "ui/index.html", content: include_str!("../templates/frontend/ui/index.html") },
    TemplateFile {
        path: ".github/workflows/plugin-release.yml",
        content: include_str!("../templates/frontend/github/plugin-release.yml"),
    },
];

const NATIVE_TEMPLATES: &[TemplateFile] = &[
    TemplateFile { path: "dbx-plugin.toml", content: include_str!("../templates/common/dbx-plugin.toml") },
    TemplateFile { path: "manifest.json", content: include_str!("../templates/common/manifest.json") },
    TemplateFile { path: "README.md", content: include_str!("../templates/common/README.md") },
    TemplateFile { path: "ui/index.html", content: include_str!("../templates/common/ui/index.html") },
    TemplateFile {
        path: ".github/workflows/plugin-release.yml",
        content: include_str!("../templates/common/github/plugin-release.yml"),
    },
];

const RUST_TEMPLATES: &[TemplateFile] = &[
    TemplateFile { path: "backend/Cargo.toml", content: include_str!("../templates/rust/backend/Cargo.toml") },
    TemplateFile { path: "backend/src/main.rs", content: include_str!("../templates/rust/backend/src/main.rs") },
];

const GO_TEMPLATES: &[TemplateFile] = &[
    TemplateFile { path: "backend/go.mod", content: include_str!("../templates/go/backend/go.mod") },
    TemplateFile { path: "backend/main.go", content: include_str!("../templates/go/backend/main.go") },
];

pub fn run_cli<I>(arguments: I) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    let mut arguments = arguments.into_iter();
    match arguments.next().as_deref() {
        Some("create") => run_create(arguments.collect()),
        Some("package") => run_package(arguments.collect()),
        Some("keygen") => run_keygen(arguments.collect()),
        Some("--version" | "-V" | "version") => {
            println!("{} {}", styled_stdout("dbx-plugin", ANSI_ACCENT), styled_stdout(CLI_VERSION, ANSI_MUTED));
            Ok(())
        }
        Some("--help" | "-h" | "help") | None => {
            print_usage();
            Ok(())
        }
        Some(command) => Err(format!("Unknown command '{command}'\n{}", usage())),
    }
}

fn run_create(arguments: Vec<String>) -> Result<(), String> {
    let mut inputs = CreateInputs::default();
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--template" | "-t" | "--backend" => {
                let template = ProjectTemplate::parse(value_after(&arguments, &mut index)?)?;
                set_project_template(&mut inputs.template, template, &arguments[index - 1])?;
            }
            "--language" | "-l" => {
                let template =
                    ProjectTemplate::from_language(BackendLanguage::parse(value_after(&arguments, &mut index)?)?);
                set_project_template(&mut inputs.template, template, &arguments[index - 1])?;
            }
            "--id" => inputs.plugin_id = Some(value_after(&arguments, &mut index)?.to_string()),
            "--name" => inputs.name = Some(value_after(&arguments, &mut index)?.to_string()),
            "--publisher" => inputs.publisher = Some(value_after(&arguments, &mut index)?.to_string()),
            "--description" => inputs.description = Some(value_after(&arguments, &mut index)?.to_string()),
            "--version" => inputs.version = Some(value_after(&arguments, &mut index)?.to_string()),
            "--signing-key-id" => {
                return Err(
                    "--signing-key-id is no longer used when creating plugins; official packages are signed by DBX Store after review"
                        .to_string(),
                );
            }
            "--sdk-root" => inputs.sdk_root = Some(PathBuf::from(value_after(&arguments, &mut index)?)),
            "--force" => inputs.force = true,
            "--yes" | "-y" => inputs.yes = true,
            "--help" | "-h" => {
                print_create_help();
                return Ok(());
            }
            value if value.starts_with('-') => return Err(format!("Unknown create option '{value}'")),
            value if inputs.directory.is_none() => inputs.directory = Some(PathBuf::from(value)),
            value => return Err(format!("Unexpected create argument '{value}'")),
        }
        index += 1;
    }
    let interactive = !inputs.yes && io::stdin().is_terminal() && io::stdout().is_terminal();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let options = resolve_create_options(inputs, interactive, &mut reader, &mut writer)?;
    drop(writer);
    drop(reader);
    if let Some(options) = options {
        create_project(&options)?;
    }
    Ok(())
}

fn run_package(arguments: Vec<String>) -> Result<(), String> {
    let mut project = PathBuf::from(".");
    let mut project_set = false;
    let mut target = None;
    let mut output_directory = None;
    let mut artifact_url = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--target" => target = Some(value_after(&arguments, &mut index)?.to_string()),
            "--output-dir" => output_directory = Some(PathBuf::from(value_after(&arguments, &mut index)?)),
            "--artifact-url" => artifact_url = Some(value_after(&arguments, &mut index)?.to_string()),
            "--key-id" => {
                return Err(
                    "--key-id is no longer supported by dbx-plugin package; build an unsigned candidate, then let the repository operator sign it after review"
                        .to_string(),
                );
            }
            "--help" | "-h" => {
                print_package_help();
                return Ok(());
            }
            value if value.starts_with('-') => return Err(format!("Unknown package option '{value}'")),
            value if !project_set => {
                project = PathBuf::from(value);
                project_set = true;
            }
            value => return Err(format!("Unexpected package argument '{value}'")),
        }
        index += 1;
    }
    package_project(&PackageOptions { project, target, output_directory, artifact_url })?;
    Ok(())
}

fn run_keygen(arguments: Vec<String>) -> Result<(), String> {
    let mut key_id = None;
    let mut output = PathBuf::from(".dbx-repository-signing-key.env");
    let mut force = false;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--key-id" => key_id = Some(value_after(&arguments, &mut index)?.to_string()),
            "--output" | "-o" => output = PathBuf::from(value_after(&arguments, &mut index)?),
            "--force" => force = true,
            "--help" | "-h" => {
                print_keygen_help();
                return Ok(());
            }
            value if value.starts_with('-') => return Err(format!("Unknown keygen option '{value}'")),
            value if key_id.is_none() => key_id = Some(value.to_string()),
            value => return Err(format!("Unexpected keygen argument '{value}'")),
        }
        index += 1;
    }

    let interactive = io::stdin().is_terminal() && io::stdout().is_terminal();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let key_id = match key_id {
        Some(value) => resolve_string(
            Some(value),
            interactive,
            "Signing key ID",
            "example.release".to_string(),
            dbx_plugin_packager::validate_key_id,
            &mut reader,
            &mut writer,
        )?,
        None if interactive => resolve_string(
            None,
            true,
            "Signing key ID",
            "example.release".to_string(),
            dbx_plugin_packager::validate_key_id,
            &mut reader,
            &mut writer,
        )?,
        None => return Err(format!("Signing key ID is required\n{}", keygen_usage())),
    };
    drop(writer);
    drop(reader);

    let material = generate_signing_key_file(&key_id, &output, force)?;
    println!("{} Saved private signing material to {}", styled_stdout("Success:", ANSI_SUCCESS), output.display());
    println!("{} {key_id}", styled_stdout("Key ID:", ANSI_PROMPT));
    println!("{} {}", styled_stdout("Public key:", ANSI_PROMPT), material.public_key_base64);
    println!(
        "{} Use DBX_PLUGIN_SIGNING_KEY only in repository signing CI; publish only the repository key ID and public key.",
        styled_stdout("Next:", ANSI_WARNING)
    );
    Ok(())
}

pub fn generate_signing_key_file(
    key_id: &str,
    output: &Path,
    force: bool,
) -> Result<dbx_plugin_packager::SigningKeyMaterial, String> {
    dbx_plugin_packager::validate_key_id(key_id)?;
    if let Some(parent) = output.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let material = dbx_plugin_packager::generate_signing_key()?;
    let mut options = OpenOptions::new();
    options.write(true);
    if force {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(output).map_err(|error| {
        if output.exists() && !force {
            format!("{} already exists; use --force to replace it", output.display())
        } else {
            format!("Failed to create {}: {error}", output.display())
        }
    })?;
    writeln!(file, "# Keep this file secret. Do not commit it.").map_err(|error| error.to_string())?;
    writeln!(file, "export DBX_PLUGIN_SIGNING_KEY={}", material.private_seed_base64)
        .map_err(|error| error.to_string())?;
    writeln!(file, "export DBX_PLUGIN_SIGNING_KEY_ID={key_id}").map_err(|error| error.to_string())?;
    writeln!(file, "export DBX_PLUGIN_SIGNING_PUBLIC_KEY={}", material.public_key_base64)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(output, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    Ok(material)
}

fn value_after<'a>(arguments: &'a [String], index: &mut usize) -> Result<&'a str, String> {
    *index += 1;
    arguments.get(*index).map(String::as_str).ok_or_else(|| "Option requires a value".to_string())
}

fn set_project_template(
    selected: &mut Option<ProjectTemplate>,
    template: ProjectTemplate,
    option: &str,
) -> Result<(), String> {
    if selected.is_some_and(|existing| existing != template) {
        return Err(format!("{option} conflicts with the previously selected plugin template"));
    }
    *selected = Some(template);
    Ok(())
}

fn resolve_create_options<R: BufRead, W: Write>(
    inputs: CreateInputs,
    interactive: bool,
    reader: &mut R,
    writer: &mut W,
) -> Result<Option<CreateOptions>, String> {
    if interactive {
        writeln!(writer, "{}", styled_stdout("Create a DBX plugin", ANSI_ACCENT)).map_err(|error| error.to_string())?;
    }
    let directory = resolve_project_directory(inputs.directory, inputs.force, interactive, reader, writer)?;
    let slug = project_slug(&directory)?;
    let template = match inputs.template {
        Some(template) => template,
        None if interactive => prompt_project_template(reader, writer)?,
        None => ProjectTemplate::Frontend,
    };
    if template == ProjectTemplate::Frontend && inputs.sdk_root.is_some() {
        return Err("--sdk-root requires the Rust or Go plugin template".to_string());
    }
    let plugin_id = resolve_string(
        inputs.plugin_id,
        interactive,
        "Plugin ID",
        format!("com.example.{slug}"),
        |value| validate_identifier(value, "plugin id"),
        reader,
        writer,
    )?;
    let name = resolve_string(
        inputs.name,
        interactive,
        "Display name",
        title_from_slug(&slug),
        |value| validate_display_text(value, "plugin name"),
        reader,
        writer,
    )?;
    let publisher = resolve_string(
        inputs.publisher,
        interactive,
        "Publisher",
        default_publisher(&plugin_id),
        |value| validate_identifier(value, "publisher"),
        reader,
        writer,
    )?;
    let description = resolve_string(
        inputs.description,
        interactive,
        "Description",
        default_description(&name),
        |value| validate_display_text(value, "plugin description"),
        reader,
        writer,
    )?;
    let version =
        resolve_string(inputs.version, interactive, "Version", "0.1.0".to_string(), validate_semver, reader, writer)?;
    let options = CreateOptions {
        directory,
        template,
        plugin_id,
        name,
        publisher,
        description,
        version,
        sdk_root: inputs.sdk_root,
        force: inputs.force,
    };
    validate_create_options(&options)?;
    if interactive {
        print_create_summary(&options, writer)?;
        if !prompt_confirmation(reader, writer)? {
            writeln!(writer, "{}", styled_stdout("Cancelled.", ANSI_WARNING)).map_err(|error| error.to_string())?;
            return Ok(None);
        }
    }
    Ok(Some(options))
}

fn resolve_project_directory<R: BufRead, W: Write>(
    directory: Option<PathBuf>,
    force: bool,
    interactive: bool,
    reader: &mut R,
    writer: &mut W,
) -> Result<PathBuf, String> {
    match directory {
        Some(directory) => match validate_project_directory(&directory, force) {
            Ok(()) => Ok(directory),
            Err(error) if interactive => {
                writeln!(writer, "{} project directory: {error}", styled_stdout("Invalid", ANSI_WARNING))
                    .map_err(|write_error| write_error.to_string())?;
                prompt_project_directory(force, reader, writer)
            }
            Err(error) => Err(error),
        },
        None if interactive => prompt_project_directory(force, reader, writer),
        None => Err(format!("Project directory is required\n{}", create_usage())),
    }
}

fn prompt_project_directory<R: BufRead, W: Write>(
    force: bool,
    reader: &mut R,
    writer: &mut W,
) -> Result<PathBuf, String> {
    loop {
        let value = prompt_line("Project directory", "my-dbx-plugin", reader, writer)?;
        let directory = PathBuf::from(value);
        match validate_project_directory(&directory, force) {
            Ok(()) => return Ok(directory),
            Err(error) => writeln!(writer, "{} {error}", styled_stdout("Invalid:", ANSI_WARNING))
                .map_err(|write_error| write_error.to_string())?,
        }
    }
}

fn resolve_string<R: BufRead, W: Write, F>(
    value: Option<String>,
    interactive: bool,
    label: &str,
    default: String,
    validate: F,
    reader: &mut R,
    writer: &mut W,
) -> Result<String, String>
where
    F: Fn(&str) -> Result<(), String>,
{
    if let Some(value) = value {
        match validate(&value) {
            Ok(()) => return Ok(value),
            Err(error) if interactive => {
                writeln!(writer, "{} {label}: {error}", styled_stdout("Invalid", ANSI_WARNING))
                    .map_err(|write_error| write_error.to_string())?;
            }
            Err(error) => return Err(error),
        }
    }
    if !interactive {
        validate(&default)?;
        return Ok(default);
    }
    loop {
        let value = prompt_line(label, &default, reader, writer)?;
        match validate(&value) {
            Ok(()) => return Ok(value),
            Err(error) => writeln!(writer, "{} {error}", styled_stdout("Invalid:", ANSI_WARNING))
                .map_err(|write_error| write_error.to_string())?,
        }
    }
}

fn prompt_line<R: BufRead, W: Write>(
    label: &str,
    default: &str,
    reader: &mut R,
    writer: &mut W,
) -> Result<String, String> {
    write!(writer, "{} {} ", styled_stdout(label, ANSI_PROMPT), styled_stdout(format!("({default}):"), ANSI_MUTED))
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    let mut answer = String::new();
    if reader.read_line(&mut answer).map_err(|error| error.to_string())? == 0 {
        return Err(format!("Input closed while waiting for {label}"));
    }
    let answer = answer.trim();
    Ok(if answer.is_empty() { default.to_string() } else { answer.to_string() })
}

fn prompt_project_template<R: BufRead, W: Write>(reader: &mut R, writer: &mut W) -> Result<ProjectTemplate, String> {
    loop {
        writeln!(writer, "{}", styled_stdout("Plugin template:", ANSI_PROMPT)).map_err(|error| error.to_string())?;
        writeln!(writer, "  {}) Frontend only (universal package)", styled_stdout("1", ANSI_ACCENT))
            .map_err(|error| error.to_string())?;
        writeln!(writer, "  {}) Rust + frontend", styled_stdout("2", ANSI_ACCENT))
            .map_err(|error| error.to_string())?;
        writeln!(writer, "  {}) Go + frontend", styled_stdout("3", ANSI_ACCENT)).map_err(|error| error.to_string())?;
        write!(writer, "{} {} ", styled_stdout("Choose", ANSI_PROMPT), styled_stdout("(1):", ANSI_MUTED))
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        let mut answer = String::new();
        if reader.read_line(&mut answer).map_err(|error| error.to_string())? == 0 {
            return Err("Input closed while waiting for plugin template".to_string());
        }
        match answer.trim().to_ascii_lowercase().as_str() {
            "" | "1" | "frontend" | "frontend-only" | "ui" | "none" => return Ok(ProjectTemplate::Frontend),
            "2" | "rust" => return Ok(ProjectTemplate::Rust),
            "3" | "go" | "golang" => return Ok(ProjectTemplate::Go),
            _ => writeln!(writer, "{} choose 1/Frontend, 2/Rust, or 3/Go", styled_stdout("Invalid:", ANSI_WARNING))
                .map_err(|error| error.to_string())?,
        }
    }
}

fn print_create_summary<W: Write>(options: &CreateOptions, writer: &mut W) -> Result<(), String> {
    writeln!(writer, "\n{}", styled_stdout("Plugin configuration:", ANSI_ACCENT)).map_err(|error| error.to_string())?;
    writeln!(writer, "  {}      {}", styled_stdout("Directory:", ANSI_PROMPT), options.directory.display())
        .map_err(|error| error.to_string())?;
    writeln!(writer, "  {}       {}", styled_stdout("Template:", ANSI_PROMPT), options.template.label())
        .map_err(|error| error.to_string())?;
    writeln!(writer, "  {}      {}", styled_stdout("Plugin ID:", ANSI_PROMPT), options.plugin_id)
        .map_err(|error| error.to_string())?;
    writeln!(writer, "  {}   {}", styled_stdout("Display name:", ANSI_PROMPT), options.name)
        .map_err(|error| error.to_string())?;
    writeln!(writer, "  {}      {}", styled_stdout("Publisher:", ANSI_PROMPT), options.publisher)
        .map_err(|error| error.to_string())?;
    writeln!(writer, "  {}    {}", styled_stdout("Description:", ANSI_PROMPT), options.description)
        .map_err(|error| error.to_string())?;
    writeln!(writer, "  {}        {}", styled_stdout("Version:", ANSI_PROMPT), options.version)
        .map_err(|error| error.to_string())?;
    writeln!(
        writer,
        "  {}        {}",
        styled_stdout("Release:", ANSI_PROMPT),
        styled_stdout("builds unsigned candidates; DBX Store signs approved official releases", ANSI_MUTED)
    )
    .map_err(|error| error.to_string())?;
    if let Some(sdk_root) = &options.sdk_root {
        writeln!(writer, "  {}       {}", styled_stdout("SDK root:", ANSI_PROMPT), sdk_root.display())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn prompt_confirmation<R: BufRead, W: Write>(reader: &mut R, writer: &mut W) -> Result<bool, String> {
    loop {
        write!(writer, "{} {} ", styled_stdout("Create plugin?", ANSI_PROMPT), styled_stdout("[Y/n]:", ANSI_MUTED))
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        let mut answer = String::new();
        if reader.read_line(&mut answer).map_err(|error| error.to_string())? == 0 {
            return Err("Input closed while waiting for confirmation".to_string());
        }
        match answer.trim().to_ascii_lowercase().as_str() {
            "" | "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => writeln!(writer, "{} enter y or n", styled_stdout("Invalid:", ANSI_WARNING))
                .map_err(|error| error.to_string())?,
        }
    }
}

pub fn create_project(options: &CreateOptions) -> Result<(), String> {
    validate_create_options(options)?;
    let slug = project_slug(&options.directory)?;
    let binary_name = format!("dbx-plugin-{slug}");
    let method_prefix = slug.replace('_', "-");
    let sdk_root = options.sdk_root.as_ref().map(|path| canonical_directory(path)).transpose()?;
    let (rust_dependency, go_replace) = match options.template {
        ProjectTemplate::Frontend => (String::new(), String::new()),
        ProjectTemplate::Rust => (rust_sdk_dependency(sdk_root.as_deref())?, String::new()),
        ProjectTemplate::Go => (String::new(), go_sdk_replace(sdk_root.as_deref())?),
    };
    let values = template_values(options, &slug, &binary_name, &method_prefix, rust_dependency, go_replace);

    if options.directory.exists() {
        if !options.directory.is_dir() {
            return Err(format!("{} exists and is not a directory", options.directory.display()));
        }
        if !options.force && fs::read_dir(&options.directory).map_err(|error| error.to_string())?.next().is_some() {
            return Err(format!(
                "{} is not empty; use --force to overwrite generated files",
                options.directory.display()
            ));
        }
    } else {
        fs::create_dir_all(&options.directory).map_err(|error| error.to_string())?;
    }

    let mut templates = SHARED_TEMPLATES.iter().collect::<Vec<_>>();
    match options.template {
        ProjectTemplate::Frontend => templates.extend(FRONTEND_TEMPLATES),
        ProjectTemplate::Rust => {
            templates.extend(NATIVE_TEMPLATES);
            templates.extend(RUST_TEMPLATES);
        }
        ProjectTemplate::Go => {
            templates.extend(NATIVE_TEMPLATES);
            templates.extend(GO_TEMPLATES);
        }
    }
    for template in templates {
        let destination = options.directory.join(template.path);
        if destination.exists() && !options.force {
            return Err(format!("{} already exists; use --force to overwrite generated files", destination.display()));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let rendered = render(template.content, &values);
        if let Some(marker) = unresolved_template_marker(&rendered) {
            return Err(format!("Generated template {} contains unresolved marker {{{{{marker}}}}}", template.path));
        }
        fs::write(&destination, rendered).map_err(|error| error.to_string())?;
    }

    println!(
        "{} Created {} plugin at {}",
        styled_stdout("Success:", ANSI_SUCCESS),
        options.template.label(),
        options.directory.display()
    );
    println!(
        "{} {}",
        styled_stdout("Next:", ANSI_PROMPT),
        styled_stdout(format!("cd {} && dbx-plugin package .", options.directory.display()), ANSI_MUTED)
    );
    Ok(())
}

pub fn package_project(options: &PackageOptions) -> Result<(PathBuf, PathBuf), String> {
    let project = canonical_directory(&options.project)?;
    let config: ProjectConfig = toml::from_str(
        &fs::read_to_string(project.join("dbx-plugin.toml"))
            .map_err(|error| format!("Failed to read dbx-plugin.toml: {error}"))?,
    )
    .map_err(|error| format!("Invalid dbx-plugin.toml: {error}"))?;
    if config.schema_version != 1 {
        return Err(format!("Unsupported dbx-plugin.toml schema version {}", config.schema_version));
    }
    let language = config.backend.as_ref().map(|backend| BackendLanguage::parse(&backend.language)).transpose()?;
    if let Some(backend) = &config.backend {
        validate_relative_path(&backend.directory, "backend directory")?;
        validate_file_name(&backend.binary, "backend binary")?;
    }
    for include in &config.package.include {
        validate_relative_path(include, "package include")?;
    }
    let manifest_path = project.join("manifest.json");
    let manifest_raw = fs::read(&manifest_path).map_err(|error| format!("Failed to read manifest.json: {error}"))?;
    let manifest_value: Value =
        serde_json::from_slice(&manifest_raw).map_err(|error| format!("Invalid manifest.json: {error}"))?;
    let manifest: ManifestIdentity =
        serde_json::from_value(manifest_value.clone()).map_err(|error| format!("Invalid manifest.json: {error}"))?;
    if manifest.manifest_version != 1 {
        return Err(format!(
            "Unsupported manifest.json version {}; dbx-plugin packages require version 1",
            manifest.manifest_version
        ));
    }
    validate_identifier(&manifest.id, "manifest plugin id")?;
    validate_semver(&manifest.version)?;
    if manifest.entrypoints.backend.is_some() != config.backend.is_some() {
        return Err("dbx-plugin.toml and manifest.json must either both declare a backend or both omit it".to_string());
    }

    let detected_target = config.backend.as_ref().map(|_| current_target()).transpose()?;
    let target = options
        .target
        .clone()
        .or_else(|| std::env::var("DBX_PLUGIN_TARGET").ok())
        .unwrap_or_else(|| detected_target.clone().unwrap_or_else(|| "universal".to_string()));
    validate_artifact_target(&target)?;
    if let Some(detected_target) = &detected_target {
        if target != *detected_target {
            return Err(format!(
                "Native plugin target '{target}' does not match build host '{detected_target}'; run this package command on the target platform"
            ));
        }
    }
    let output_directory = match &options.output_directory {
        Some(path) if path.is_absolute() => path.clone(),
        Some(path) => project.join(path),
        None => project.join("dist"),
    };
    fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;
    let stage = CleanupDirectory::prepare(output_directory.join(format!(".stage-{}-{target}", manifest.id)))?;

    if let (Some(backend), Some(language)) = (&config.backend, language) {
        println!("{} {} backend", styled_stdout("Building:", ANSI_PROMPT), language.label());
        let executable_name = executable_name(&backend.binary);
        let binary_directory = stage.path().join("bin").join(&target);
        fs::create_dir_all(&binary_directory).map_err(|error| error.to_string())?;
        let staged_executable = binary_directory.join(&executable_name);
        let build = CleanupDirectory::prepare(output_directory.join(format!(".build-{}-{target}", language.as_str())))?;
        match language {
            BackendLanguage::Rust => build_rust_backend(&project, backend, build.path(), &staged_executable)?,
            BackendLanguage::Go => build_go_backend(&project, backend, build.path(), &staged_executable)?,
        }
    }
    let staged_manifest = package_manifest(manifest_value, config.backend.as_ref(), &target)?;
    fs::write(stage.path().join("manifest.json"), staged_manifest).map_err(|error| error.to_string())?;
    for include in &config.package.include {
        let source = project.join(include);
        if !source.exists() {
            return Err(format!("Package include {} does not exist", source.display()));
        }
        copy_path(&source, &stage.path().join(include))?;
    }

    let package_name = format!("{}-{}-{target}.dbxp", manifest.id, manifest.version);
    let package_path = output_directory.join(&package_name);
    let metadata_path = output_directory.join(package_name.replace(".dbxp", ".artifact.json"));
    let artifact_url = options.artifact_url.clone().unwrap_or(package_name);
    let packager_arguments = vec![
        stage.path().to_string_lossy().into_owned(),
        package_path.to_string_lossy().into_owned(),
        "--artifact-metadata".to_string(),
        metadata_path.to_string_lossy().into_owned(),
        "--target".to_string(),
        target,
        "--artifact-url".to_string(),
        artifact_url,
    ];
    println!("{} {}", styled_stdout("Packaging:", ANSI_PROMPT), package_path.display());
    dbx_plugin_packager::run_cli_silent(packager_arguments)?;
    println!("{} Built {}", styled_stdout("Success:", ANSI_SUCCESS), package_path.display());
    println!("{} {}", styled_stdout("Metadata:", ANSI_PROMPT), metadata_path.display());
    println!(
        "{} {}",
        styled_stdout("Signature:", ANSI_WARNING),
        styled_stdout("unsigned review candidate", ANSI_MUTED)
    );
    Ok((package_path, metadata_path))
}

fn package_manifest(mut manifest: Value, backend: Option<&BackendConfig>, target: &str) -> Result<Vec<u8>, String> {
    reject_unknown_manifest_fields(&manifest)?;
    if let Some(ui_entrypoint) = manifest
        .get_mut("entrypoints")
        .and_then(Value::as_object_mut)
        .and_then(|entrypoints| entrypoints.get_mut("ui"))
        .and_then(Value::as_object_mut)
    {
        if ui_entrypoint.contains_key("kind") {
            return Err("manifest.json entrypoints.ui.kind is obsolete; DBX plugin UI is always sandboxed".to_string());
        }
    }
    if let Some(backend) = backend {
        let entrypoints = manifest
            .get_mut("entrypoints")
            .and_then(Value::as_object_mut)
            .ok_or("manifest.json entrypoints must be an object")?;
        let backend_entrypoint = entrypoints
            .get_mut("backend")
            .and_then(Value::as_object_mut)
            .ok_or("manifest.json entrypoints.backend must be an object")?;
        if backend_entrypoint.contains_key("binaries") {
            return Err(
                "manifest.json entrypoints.backend.binaries is obsolete; package one target and declare executable"
                    .to_string(),
            );
        }
        if backend_entrypoint.contains_key("protocol") {
            return Err(
                "manifest.json entrypoints.backend.protocol is obsolete; DBX manifest v1 uses the DBX JSON-RPC protocol"
                    .to_string(),
            );
        }
        if backend_entrypoint
            .get("protocol_versions")
            .and_then(Value::as_array)
            .is_some_and(|versions| versions.as_slice() == [Value::from(1)])
        {
            backend_entrypoint.remove("protocol_versions");
        }
        if backend_entrypoint.get("transport").and_then(Value::as_str) == Some("stdio-jsonl") {
            backend_entrypoint.remove("transport");
        }
        backend_entrypoint.insert(
            "executable".to_string(),
            Value::String(format!("bin/{target}/{}", executable_name(&backend.binary))),
        );
    }
    let mut bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn reject_unknown_manifest_fields(manifest: &Value) -> Result<(), String> {
    const ALLOWED_FIELDS: &[&str] = &[
        "$schema",
        "manifest_version",
        "id",
        "name",
        "icon",
        "version",
        "publisher",
        "description",
        "engines",
        "permissions",
        "entrypoints",
        "contributions",
        "localizations",
    ];
    let object = manifest.as_object().ok_or("manifest.json must be an object")?;
    let unknown = object.keys().filter(|key| !ALLOWED_FIELDS.contains(&key.as_str())).cloned().collect::<Vec<_>>();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!("manifest.json contains unknown top-level field(s): {}", unknown.join(", ")))
    }
}

fn build_rust_backend(
    project: &Path,
    backend: &BackendConfig,
    target_directory: &Path,
    staged_executable: &Path,
) -> Result<(), String> {
    let backend_directory = project.join(&backend.directory);
    let manifest = backend_directory.join("Cargo.toml");
    if !manifest.is_file() {
        return Err(format!("Rust backend is missing {}", manifest.display()));
    }
    let mut command = Command::new("cargo");
    command.arg("build").arg("--release").arg("--manifest-path").arg(&manifest);
    if backend_directory.join("Cargo.lock").is_file() {
        command.arg("--locked");
    }
    if let Some(sdk_root) = sdk_root_from_environment()? {
        let sdk = sdk_root.join("plugins/sdk/rust/dbx-plugin-sdk");
        if !sdk.join("Cargo.toml").is_file() {
            return Err(format!("Rust plugin SDK was not found at {}", sdk.display()));
        }
        command.arg("--config").arg(format!(
            "patch.crates-io.dbx-plugin-sdk.path={}",
            serde_json::to_string(&sdk.to_string_lossy()).map_err(|error| error.to_string())?
        ));
    }
    command.env("CARGO_TARGET_DIR", target_directory);
    run_command(&mut command, "Rust backend build")?;
    let built = target_directory.join("release").join(executable_name(&backend.binary));
    fs::copy(&built, staged_executable)
        .map_err(|error| format!("Failed to copy Rust backend {}: {error}", built.display()))?;
    Ok(())
}

fn build_go_backend(
    project: &Path,
    backend: &BackendConfig,
    build_directory: &Path,
    staged_executable: &Path,
) -> Result<(), String> {
    let backend_directory = project.join(&backend.directory);
    if !backend_directory.join("go.mod").is_file() {
        return Err(format!("Go backend is missing {}/go.mod", backend_directory.display()));
    }
    let mut command = Command::new("go");
    command.current_dir(&backend_directory).arg("build").arg("-trimpath").arg("-o").arg(staged_executable).arg(".");
    if let Some(sdk_root) = sdk_root_from_environment()? {
        let sdk = sdk_root.join("plugins/sdk/go/dbx-plugin-sdk");
        if !sdk.join("go.mod").is_file() {
            return Err(format!("Go plugin SDK was not found at {}", sdk.display()));
        }
        fs::create_dir_all(build_directory).map_err(|error| error.to_string())?;
        let work_file = build_directory.join("go.work");
        fs::write(
            &work_file,
            format!(
                "go 1.22\n\nuse (\n\t{}\n\t{}\n)\n",
                serde_json::to_string(&backend_directory.to_string_lossy()).map_err(|error| error.to_string())?,
                serde_json::to_string(&sdk.to_string_lossy()).map_err(|error| error.to_string())?
            ),
        )
        .map_err(|error| error.to_string())?;
        command.env("GOWORK", work_file);
    }
    run_command(&mut command, "Go backend build")
}

fn run_command(command: &mut Command, label: &str) -> Result<(), String> {
    command.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    let status = command.status().map_err(|error| format!("Failed to start {label}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{label} failed with {status}"))
    }
}

fn copy_path(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!("Package input cannot contain symbolic link {}", source.display()));
    }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!("Unsupported package input {}", source.display()));
    }
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        copy_path(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn template_values(
    options: &CreateOptions,
    slug: &str,
    binary_name: &str,
    method_prefix: &str,
    rust_dependency: String,
    go_replace: String,
) -> BTreeMap<&'static str, String> {
    let backend_language = options.template.backend_language();
    BTreeMap::from([
        ("PLUGIN_ID", options.plugin_id.clone()),
        ("PLUGIN_NAME", options.name.clone()),
        ("PLUGIN_NAME_JSON", json_string_content(&options.name)),
        ("PLUGIN_NAME_HTML", escape_html(&options.name)),
        ("PLUGIN_NAME_XML", escape_html(&options.name)),
        ("PLUGIN_NAME_RUST", escape_code_string(&options.name)),
        ("PLUGIN_NAME_GO", escape_code_string(&options.name)),
        ("DESCRIPTION", options.description.clone()),
        ("DESCRIPTION_JSON", json_string_content(&options.description)),
        ("PUBLISHER", options.publisher.clone()),
        ("PUBLISHER_JSON", json_string_content(&options.publisher)),
        ("VERSION", options.version.clone()),
        ("TEMPLATE", options.template.as_str().to_string()),
        ("TEMPLATE_LABEL", options.template.label().to_string()),
        ("LANGUAGE", backend_language.map(BackendLanguage::as_str).unwrap_or("none").to_string()),
        ("LANGUAGE_LABEL", backend_language.map(BackendLanguage::label).unwrap_or("No native backend").to_string()),
        ("BINARY_NAME", binary_name.to_string()),
        ("METHOD_PREFIX", method_prefix.to_string()),
        ("CONNECTION_TYPE", slug.to_string()),
        ("RUST_SDK_DEPENDENCY", rust_dependency),
        ("GO_MODULE", format!("github.com/{}/{slug}", options.publisher)),
        ("GO_SDK_REPLACE", go_replace),
    ])
}

fn render(template: &str, values: &BTreeMap<&str, String>) -> String {
    values
        .iter()
        .fold(template.to_string(), |rendered, (key, value)| rendered.replace(&format!("{{{{{key}}}}}"), value))
}

fn unresolved_template_marker(rendered: &str) -> Option<String> {
    rendered.split("{{").skip(1).find_map(|suffix| {
        let (marker, _) = suffix.split_once("}}")?;
        (!marker.is_empty()
            && marker
                .chars()
                .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'))
        .then(|| marker.to_string())
    })
}

fn rust_sdk_dependency(sdk_root: Option<&Path>) -> Result<String, String> {
    match sdk_root {
        Some(root) => {
            let path = root.join("plugins/sdk/rust/dbx-plugin-sdk");
            if !path.join("Cargo.toml").is_file() {
                return Err(format!("Rust plugin SDK was not found at {}", path.display()));
            }
            Ok(format!("{{ path = \"{}\" }}", escape_toml_path(&path)))
        }
        None => Ok(format!("{{ version = \"{SDK_VERSION}\" }}")),
    }
}

fn go_sdk_replace(sdk_root: Option<&Path>) -> Result<String, String> {
    match sdk_root {
        Some(root) => {
            let path = root.join("plugins/sdk/go/dbx-plugin-sdk");
            if !path.join("go.mod").is_file() {
                return Err(format!("Go plugin SDK was not found at {}", path.display()));
            }
            Ok(format!("replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => {}", path.display()))
        }
        None => Ok(String::new()),
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err(format!("{} is not a directory", canonical.display()))
    }
}

fn sdk_root_from_environment() -> Result<Option<PathBuf>, String> {
    std::env::var_os("DBX_PLUGIN_SDK_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| canonical_directory(&path))
        .transpose()
}

fn validate_create_options(options: &CreateOptions) -> Result<(), String> {
    validate_project_directory(&options.directory, options.force)?;
    validate_identifier(&options.plugin_id, "plugin id")?;
    validate_identifier(&options.publisher, "publisher")?;
    validate_semver(&options.version)?;
    validate_display_text(&options.name, "plugin name")?;
    validate_display_text(&options.description, "plugin description")?;
    if options.template == ProjectTemplate::Frontend && options.sdk_root.is_some() {
        return Err("SDK root is only supported by Rust or Go plugin templates".to_string());
    }
    Ok(())
}

fn validate_project_directory(directory: &Path, force: bool) -> Result<(), String> {
    project_slug(directory)?;
    if !directory.exists() {
        return Ok(());
    }
    if !directory.is_dir() {
        return Err(format!("{} exists and is not a directory", directory.display()));
    }
    if !force && fs::read_dir(directory).map_err(|error| error.to_string())?.next().is_some() {
        return Err(format!("{} is not empty; use --force to overwrite generated files", directory.display()));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || index > 0 && matches!(character, '.' | '_' | '-')
        })
    {
        return Err(format!("{label} must use lowercase letters, digits, dots, underscores, or hyphens"));
    }
    Ok(())
}

fn validate_semver(value: &str) -> Result<(), String> {
    semver::Version::parse(value)
        .map(|_| ())
        .map_err(|_| "Version must be valid SemVer such as 1.0.0 or 1.0.0-beta.1".to_string())
}

fn validate_display_text(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(format!("{label} must be non-empty and cannot contain control characters"));
    }
    Ok(())
}

fn validate_relative_path(path: &Path, label: &str) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("{label} must be a safe relative path"));
    }
    Ok(())
}

fn validate_file_name(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || Path::new(value).file_name() != Some(OsStr::new(value)) {
        return Err(format!("{label} must be a file name"));
    }
    Ok(())
}

fn project_slug(directory: &Path) -> Result<String, String> {
    let name = directory.file_name().and_then(OsStr::to_str).ok_or("Project directory needs a UTF-8 name")?;
    let slug = name
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        Err("Project directory name must contain letters or digits".to_string())
    } else {
        Ok(slug)
    }
}

fn title_from_slug(slug: &str) -> String {
    slug.split('-').filter(|part| !part.is_empty()).map(title_word).collect::<Vec<_>>().join(" ")
}

fn title_word(word: &str) -> String {
    match word {
        "api" | "dbx" | "http" | "https" | "jdbc" | "sdk" | "sftp" | "sql" | "ssh" | "tcp" | "tls" | "udp" | "ui" => {
            word.to_ascii_uppercase()
        }
        _ => {
            let mut characters = word.chars();
            characters
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + characters.as_str())
                .unwrap_or_default()
        }
    }
}

fn default_description(name: &str) -> String {
    if name.to_ascii_lowercase().ends_with(" plugin") {
        format!("{name} for DBX.")
    } else {
        format!("{name} plugin for DBX.")
    }
}

fn default_publisher(plugin_id: &str) -> String {
    plugin_id.split('.').nth(1).filter(|value| !value.is_empty()).unwrap_or("example").to_string()
}

fn current_target() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        value => return Err(format!("Unsupported plugin operating system '{value}'")),
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => return Err(format!("Unsupported plugin architecture '{value}'")),
    };
    Ok(format!("{os}-{architecture}"))
}

fn validate_artifact_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.len() > 64
        || !target
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
    {
        return Err("Artifact target contains unsupported characters".to_string());
    }
    Ok(())
}

fn executable_name(binary: &str) -> String {
    if cfg!(windows) {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    }
}

fn json_string_content(value: &str) -> String {
    let encoded = serde_json::to_string(value).expect("serializing a string cannot fail");
    encoded[1..encoded.len() - 1].to_string()
}

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn escape_code_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn escape_toml_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
}

fn print_usage() {
    println!(
        "{} {}",
        styled_stdout("dbx-plugin", ANSI_ACCENT),
        styled_stdout("Create, sign, and package DBX plugins", ANSI_MUTED)
    );
    println!("\n{}", styled_stdout("Usage:", ANSI_PROMPT));
    println!("  dbx-plugin <command> [options]");
    println!("\n{}", styled_stdout("Commands:", ANSI_PROMPT));
    println!("  {}     Create a frontend-only, Rust, or Go plugin project", styled_stdout("create", ANSI_SUCCESS));
    println!("  {}    Build a .dbxp package and artifact metadata", styled_stdout("package", ANSI_SUCCESS));
    println!("  {}     Generate an Ed25519 repository signing key", styled_stdout("keygen", ANSI_SUCCESS));
    println!("  {}    Print the CLI version", styled_stdout("version", ANSI_SUCCESS));
    println!("\n{}", styled_stdout("Examples:", ANSI_PROMPT));
    println!("  dbx-plugin create");
    println!("  dbx-plugin create my-plugin --template frontend --yes");
    println!("  dbx-plugin keygen example.release");
    println!("  dbx-plugin package .");
    println!("\nRun dbx-plugin <command> --help for command options.");
}

fn print_create_help() {
    println!("{}", styled_stdout("Create a DBX plugin project", ANSI_ACCENT));
    println!("\n{}\n  {}", styled_stdout("Usage:", ANSI_PROMPT), create_usage());
    println!("\n{}", styled_stdout("Templates:", ANSI_PROMPT));
    println!("  {}   Sandboxed UI only; packages once as universal", styled_stdout("frontend", ANSI_SUCCESS));
    println!("  {}       Sandboxed UI plus a Rust sidecar", styled_stdout("rust", ANSI_SUCCESS));
    println!("  {}         Sandboxed UI plus a Go sidecar", styled_stdout("go", ANSI_SUCCESS));
    println!("\n{}", styled_stdout("Options:", ANSI_PROMPT));
    println!("  -t, --template TYPE       frontend, rust, or go (default: frontend)");
    println!("      --backend TYPE        Alias accepting none, rust, or go");
    println!("  -l, --language LANGUAGE   Compatibility alias for rust or go");
    println!("      --id ID               Reverse-domain plugin ID");
    println!("      --name NAME           Display name");
    println!("      --publisher NAME      Publisher identifier");
    println!("      --description TEXT    Plugin description");
    println!("      --version VERSION     Strict semantic version (default: 0.1.0)");
    println!("      --sdk-root PATH       Local DBX SDK checkout for Rust or Go templates");
    println!("      --force               Overwrite generated files");
    println!("  -y, --yes                 Use defaults without prompts");
    println!("  -h, --help                Print this help");
    println!("\nGenerated release workflows publish unsigned candidates for DBX Store review and signing.");
}

fn print_package_help() {
    println!("{}", styled_stdout("Package a DBX plugin", ANSI_ACCENT));
    println!("\n{}\n  {}", styled_stdout("Usage:", ANSI_PROMPT), package_usage());
    println!("\n{}", styled_stdout("Behavior:", ANSI_PROMPT));
    println!("  Frontend-only projects default to target universal.");
    println!("  Rust and Go projects build a native sidecar for the current host target.");
    println!("  Packages are always unsigned review candidates.");
    println!("  The official store or a custom repository operator signs approved candidates separately.");
    println!("\n{}", styled_stdout("Options:", ANSI_PROMPT));
    println!("      --target TARGET       Artifact target or DBX_PLUGIN_TARGET");
    println!("      --output-dir DIR      Output directory (default: dist)");
    println!("      --artifact-url URL    URL recorded in artifact metadata");
    println!("  -h, --help                Print this help");
}

fn print_keygen_help() {
    println!("{}", styled_stdout("Generate a repository signing key", ANSI_ACCENT));
    println!("\n{}\n  {}", styled_stdout("Usage:", ANSI_PROMPT), keygen_usage());
    println!("\n{}", styled_stdout("Output:", ANSI_PROMPT));
    println!("  Writes a private environment file with mode 0600 on Unix.");
    println!(
        "  Intended for private or custom repository operators; official DBX Store authors do not need this command."
    );
    println!("\n{}", styled_stdout("Options:", ANSI_PROMPT));
    println!("      --key-id ID       Public repository key identifier");
    println!("  -o, --output FILE     Secret output file (default: .dbx-repository-signing-key.env)");
    println!("      --force           Replace an existing output file");
    println!("  -h, --help            Print this help");
    println!("\nNever commit the generated private environment file.");
}

fn usage() -> String {
    format!("{}\n{}\n{}\nRun 'dbx-plugin --help' for details.", create_usage(), package_usage(), keygen_usage())
}

fn create_usage() -> String {
    "dbx-plugin create [directory] [--template frontend|rust|go] [options]".to_string()
}

fn package_usage() -> String {
    "dbx-plugin package [project] [--target TARGET] [--output-dir DIR] [--artifact-url URL]".to_string()
}

fn keygen_usage() -> String {
    "dbx-plugin keygen [KEY_ID] [--output FILE] [--force]".to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::PathBuf;

    use super::{
        color_enabled_with, create_project, generate_signing_key_file, package_manifest, package_project,
        resolve_create_options, run_cli, styled, title_from_slug, validate_semver, BackendConfig, CreateInputs,
        CreateOptions, PackageOptions, ProjectTemplate, ANSI_ACCENT,
    };

    #[test]
    fn enables_colors_only_for_supported_terminal_modes() {
        assert!(color_enabled_with(true, false, Some("xterm-256color"), None, None));
        assert!(!color_enabled_with(false, false, Some("xterm-256color"), None, None));
        assert!(!color_enabled_with(true, true, Some("xterm-256color"), None, Some("1")));
        assert!(!color_enabled_with(true, false, Some("dumb"), None, None));
        assert!(!color_enabled_with(true, false, Some("xterm-256color"), Some("0"), None));
        assert!(color_enabled_with(false, false, None, None, Some("1")));
    }

    #[test]
    fn styles_text_without_changing_plain_output() {
        assert_eq!(styled("DBX", ANSI_ACCENT, false), "DBX");
        assert_eq!(styled("DBX", ANSI_ACCENT, true), "\x1b[1;35mDBX\x1b[0m");
    }

    #[test]
    fn generates_secret_file_without_overwriting_by_default() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("repository.env");
        let material = generate_signing_key_file("example.release", &output, false).unwrap();
        let content = std::fs::read_to_string(&output).unwrap();
        assert!(content.contains(&format!("export DBX_PLUGIN_SIGNING_KEY={}", material.private_seed_base64)));
        assert!(content.contains("export DBX_PLUGIN_SIGNING_KEY_ID=example.release"));
        assert!(content.contains(&format!("export DBX_PLUGIN_SIGNING_PUBLIC_KEY={}", material.public_key_base64)));
        assert!(generate_signing_key_file("example.release", &output, false).is_err());
        generate_signing_key_file("example.release", &output, true).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(std::fs::metadata(output).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
    #[test]
    fn noninteractive_create_defaults_to_frontend_candidate_workflow() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("default-project");
        let mut reader = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        let options = resolve_create_options(
            CreateInputs { directory: Some(directory), yes: true, ..CreateInputs::default() },
            false,
            &mut reader,
            &mut output,
        )
        .unwrap()
        .unwrap();
        assert_eq!(options.template, ProjectTemplate::Frontend);
    }

    #[test]
    fn rejects_conflicting_template_aliases() {
        let error = run_cli(
            ["create", "--template", "frontend", "--language", "rust", "--yes"].into_iter().map(str::to_string),
        )
        .unwrap_err();
        assert!(error.contains("conflicts with the previously selected plugin template"));
    }

    #[test]
    fn rejects_package_signing_options() {
        let error = run_cli(["package", "--key-id", "example.release"].into_iter().map(str::to_string)).unwrap_err();
        assert!(error.contains("build an unsigned candidate"));
    }

    #[test]
    fn rejects_obsolete_backend_binary_maps() {
        let manifest = serde_json::json!({
            "entrypoints": {
                "backend": {
                    "binaries": { "darwin-arm64": "bin/plugin" }
                }
            }
        });
        let backend =
            BackendConfig { language: "rust".to_string(), directory: "backend".into(), binary: "plugin".to_string() };

        assert!(package_manifest(manifest, Some(&backend), "darwin-arm64")
            .unwrap_err()
            .contains("entrypoints.backend.binaries is obsolete"));
    }

    #[test]
    fn rejects_obsolete_fixed_entrypoint_fields() {
        let backend =
            BackendConfig { language: "rust".to_string(), directory: "backend".into(), binary: "plugin".to_string() };
        let backend_manifest = serde_json::json!({
            "entrypoints": {
                "backend": {
                    "protocol": "dbx-jsonrpc",
                    "executable": "bin/plugin"
                }
            }
        });
        let ui_manifest = serde_json::json!({
            "entrypoints": {
                "ui": {
                    "kind": "sandbox-webview",
                    "entry": "ui/index.html"
                }
            }
        });

        assert!(package_manifest(backend_manifest, Some(&backend), "darwin-arm64")
            .unwrap_err()
            .contains("entrypoints.backend.protocol is obsolete"));
        assert!(package_manifest(ui_manifest, None, "universal")
            .unwrap_err()
            .contains("entrypoints.ui.kind is obsolete"));
    }

    #[test]
    fn rejects_unknown_top_level_manifest_fields() {
        let manifest = serde_json::json!({
            "manifest_version": 1,
            "id": "com.example.unknown",
            "name": "Unknown",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "host_api": "1" },
            "activation_events": ["onStartup"]
        });

        assert!(package_manifest(manifest, None, "universal")
            .unwrap_err()
            .contains("unknown top-level field(s): activation_events"));
    }

    #[test]
    fn package_validation_and_failures_leave_no_temporary_directories() {
        let root = tempfile::tempdir().unwrap();
        let mismatch = root.path().join("mismatch");
        create_project(&CreateOptions {
            directory: mismatch.clone(),
            template: ProjectTemplate::Frontend,
            plugin_id: "com.example.mismatch".to_string(),
            name: "Mismatch".to_string(),
            publisher: "example".to_string(),
            description: "Mismatch package".to_string(),
            version: "1.0.0".to_string(),
            sdk_root: None,
            force: false,
        })
        .unwrap();
        std::fs::write(
            mismatch.join("dbx-plugin.toml"),
            "schema_version = 1\n\n[backend]\nlanguage = \"rust\"\ndirectory = \"backend\"\nbinary = \"mismatch\"\n\n[package]\ninclude = [\"assets\", \"ui\"]\n",
        )
        .unwrap();
        let error = package_project(&PackageOptions {
            project: mismatch,
            target: Some("universal".to_string()),
            output_directory: None,
            artifact_url: None,
        })
        .unwrap_err();
        assert!(error.contains("must either both declare a backend or both omit it"));

        let missing_include = root.path().join("missing-include");
        create_project(&CreateOptions {
            directory: missing_include.clone(),
            template: ProjectTemplate::Frontend,
            plugin_id: "com.example.missing-include".to_string(),
            name: "Missing Include".to_string(),
            publisher: "example".to_string(),
            description: "Missing include package".to_string(),
            version: "1.0.0".to_string(),
            sdk_root: None,
            force: false,
        })
        .unwrap();
        std::fs::remove_dir_all(missing_include.join("ui")).unwrap();
        assert!(package_project(&PackageOptions {
            project: missing_include.clone(),
            target: Some("universal".to_string()),
            output_directory: None,
            artifact_url: None,
        })
        .is_err());
        assert!(std::fs::read_dir(missing_include.join("dist")).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.starts_with(".stage-") && !name.starts_with(".build-")
        }));
    }
    #[test]
    fn creates_frontend_rust_and_go_projects() {
        let root = tempfile::tempdir().unwrap();
        let sdk_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        for template in [ProjectTemplate::Frontend, ProjectTemplate::Rust, ProjectTemplate::Go] {
            let directory = root.path().join(template.as_str());
            create_project(&CreateOptions {
                directory: directory.clone(),
                template,
                plugin_id: format!("com.example.{}", template.as_str()),
                name: format!("{} example", template.label()),
                publisher: "example".to_string(),
                description: "Generated plugin".to_string(),
                version: "1.2.3".to_string(),
                sdk_root: (template != ProjectTemplate::Frontend).then(|| sdk_root.clone()),
                force: false,
            })
            .unwrap();

            assert!(directory.join("manifest.json").is_file());
            assert!(directory.join("ui/index.html").is_file());
            assert!(directory.join(".github/workflows/plugin-release.yml").is_file());
            let readme = std::fs::read_to_string(directory.join("README.md")).unwrap();
            assert!(readme.contains("Plugin submission Issue"));
            assert!(readme.contains("t8y2/dbx-store:main"));
            assert!(readme.contains("Do not submit ordinary plugin source to `t8y2/dbx`"));
            assert!(std::fs::read_to_string(directory.join(".gitignore"))
                .unwrap()
                .contains(".dbx-repository-signing-key.env"));
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).unwrap()).unwrap();
            assert_eq!(manifest["version"], "1.2.3");
            let config: toml::Value =
                toml::from_str(&std::fs::read_to_string(directory.join("dbx-plugin.toml")).unwrap()).unwrap();
            let workflow = std::fs::read_to_string(directory.join(".github/workflows/plugin-release.yml")).unwrap();
            assert!(!workflow.contains("signing-key-id"));
            assert!(!workflow.contains("DBX_PLUGIN_SIGNING_KEY"));
            assert!(workflow.contains("plugin-cli-version: 0.1.0"));
            assert!(!workflow.contains("sdk-ref:"));

            match template {
                ProjectTemplate::Frontend => {
                    assert!(manifest["entrypoints"].get("backend").is_none());
                    assert!(config.get("backend").is_none());
                    assert!(!directory.join("backend").exists());
                    assert!(workflow.contains("\"target\":\"universal\""));
                }
                ProjectTemplate::Rust => {
                    assert!(manifest["entrypoints"].get("backend").is_some());
                    assert!(config.get("backend").is_some());
                    assert!(directory.join("backend/src/main.rs").is_file());
                }
                ProjectTemplate::Go => {
                    assert!(manifest["entrypoints"].get("backend").is_some());
                    assert!(config.get("backend").is_some());
                    assert!(directory.join("backend/main.go").is_file());
                }
            }
        }
    }

    #[test]
    fn packages_frontend_project_as_universal_without_build_residue() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("frontend-package");
        create_project(&CreateOptions {
            directory: directory.clone(),
            template: ProjectTemplate::Frontend,
            plugin_id: "com.example.frontend-package".to_string(),
            name: "Frontend Package".to_string(),
            publisher: "example".to_string(),
            description: "Frontend-only package".to_string(),
            version: "1.2.3".to_string(),
            sdk_root: None,
            force: false,
        })
        .unwrap();

        let (package, metadata) = package_project(&PackageOptions {
            project: directory.clone(),
            target: Some("universal".to_string()),
            output_directory: None,
            artifact_url: None,
        })
        .unwrap();
        assert_eq!(package.file_name().unwrap(), "com.example.frontend-package-1.2.3-universal.dbxp");
        assert!(package.is_file());
        assert!(metadata.is_file());
        let artifact: serde_json::Value = serde_json::from_slice(&std::fs::read(metadata).unwrap()).unwrap();
        assert_eq!(artifact["target"], "universal");
        assert!(std::fs::read_dir(directory.join("dist")).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.starts_with(".stage-") && !name.starts_with(".build-")
        }));
    }

    #[test]
    fn interactive_wizard_reprompts_invalid_values() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("wizard-plugin");
        let input = format!("{}\n4\n3\nInvalid ID\ncom.acme.wizard\n\n\n\n1\n1.2.3\nmaybe\ny\n", directory.display());
        let mut reader = Cursor::new(input.into_bytes());
        let mut output = Vec::new();
        let options = resolve_create_options(CreateInputs::default(), true, &mut reader, &mut output).unwrap().unwrap();

        assert_eq!(options.directory, directory);
        assert_eq!(options.template, ProjectTemplate::Go);
        assert_eq!(options.plugin_id, "com.acme.wizard");
        assert_eq!(options.name, "Wizard Plugin");
        assert_eq!(options.publisher, "acme");
        assert_eq!(options.description, "Wizard Plugin for DBX.");
        assert_eq!(options.version, "1.2.3");
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("Invalid: choose 1/Frontend, 2/Rust, or 3/Go"));
        assert!(output.contains("Invalid: plugin id must use lowercase letters"));
        assert!(output.contains("Invalid: Version must be valid SemVer"));
        assert!(output.contains("DBX Store signs approved official releases"));
        assert!(output.contains("Plugin configuration:"));
        assert!(output.contains("Invalid: enter y or n"));
    }

    #[test]
    fn formats_common_plugin_acronyms_and_validates_semver() {
        assert_eq!(title_from_slug("dbx-ssh-sftp-workbench"), "DBX SSH SFTP Workbench");
        validate_semver("1.2.3-beta.1+darwin.arm64").unwrap();
        assert!(validate_semver("1.2.3-").is_err());
        assert!(validate_semver("01.2.3").is_err());
    }
}
