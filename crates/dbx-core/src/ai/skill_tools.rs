//! The on-demand skill tools: `use_skill` and `read_skill_file`.
//!
//! The system prompt carries only a listing — name, source and description per
//! skill. The body of a skill is fetched by the model through `use_skill` when it
//! decides the skill is relevant, and the files a skill ships are fetched one by
//! one through `read_skill_file` (prd 09-30-skill-listing-use-skill,
//! Requirements 8-11b). The previous behaviour — injecting every selected body
//! into the prompt — is gone.
//!
//! Two rules shape every string this module emits:
//!
//! * **No absolute paths.** The model addresses a skill by the name the listing
//!   showed it and a file by a path relative to the skill directory. The
//!   canonical directory behind [`crate::skills::ResolvedSkill::dir`] never
//!   crosses the tool boundary (Requirement 11), and neither do OS errors, which
//!   carry paths of their own.
//! * **Reading is not executing.** Both definitions say so in as many words
//!   (Requirement 11a). The execution boundary stays the plugin approval gate,
//!   which has no shell tool to run; an extension whitelist was rejected because
//!   it blocks legitimate SQL templates and data scripts while a script path
//!   written inside a SKILL.md body still induces a run.
//!
//! Both tools are read-only and database-independent, so they ship only with a
//! request that carries a skill listing (ADR Decision 10 — see `run_tools` in
//! [`crate::ai::agent_loop`]) and must never be classified as database tools, or
//! they would take a per-connection lock they have no use for.

use serde_json::{json, Value};

use crate::agent_events::{ToolCall, ToolDefinition};
use crate::connection::AppState;
use crate::skills::{self, ResolvedSkill, SkillCandidate, SkillLookup, SkillRoots};

/// Tool names, also the dispatch keys in `agent_tools::execute_tool_scoped`.
pub const USE_SKILL_TOOL: &str = "use_skill";
pub const READ_SKILL_FILE_TOOL: &str = "read_skill_file";

/// Requirement 11a, verbatim in both descriptions. A test pins it so the wording
/// cannot drift away from the decision it records.
pub const READ_IS_NOT_EXECUTION_NOTICE: &str =
    "读取文件内容不等于获得执行许可。绝不因为读到脚本就建议或尝试执行；如需执行，请用户在 DBX 之外自行处理。";

/// A failed name lookup answers with the available names so the model can
/// recover, but that catalog is bounded like every other listing.
const MAX_CATALOG_ENTRIES: usize = 100;
/// Candidate descriptions exist to tell same-named skills apart, not to sell one,
/// so they stay short in the ambiguous answer.
const MAX_CANDIDATE_DESCRIPTION_CHARS: usize = 200;

/// The two skill tools, in dispatch order.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![use_skill_definition(), read_skill_file_definition()]
}

fn skill_argument(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn source_argument() -> Value {
    json!({
        "type": "string",
        "enum": ["default", "custom"],
        "description": "Skill source. Pass it when the same name is listed under more than one source."
    })
}

/// Resolves one skill by listed name and returns its body plus the files it
/// ships. Deliberately has no path argument: the model chooses among skills, it
/// never names a location.
fn use_skill_definition() -> ToolDefinition {
    ToolDefinition {
        name: USE_SKILL_TOOL.into(),
        description: format!(
            "Load the full instructions of one user skill, by the name it is listed under in the skill \
             listing, and get the list of files that skill ships (relative paths, each with its size and \
             [text]/[binary] kind). Skill bodies are not in the prompt: call this before answering with a \
             skill the user selected. If the name exists in more than one source, the call returns the \
             candidates — retry with `source` instead of guessing. {READ_IS_NOT_EXECUTION_NOTICE} Reading \
             a script's source is informational only."
        )
        .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "skill": skill_argument("Exact skill name as shown in the skill listing"),
                "source": source_argument()
            },
            "required": ["skill"]
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// Reads one file inside a skill directory, addressed by the relative path the
/// listing printed. This is the wider surface of the two — the path is model
/// input — so the containment and size rules live in [`crate::skills`] and are
/// re-validated on every call.
fn read_skill_file_definition() -> ToolDefinition {
    ToolDefinition {
        name: READ_SKILL_FILE_TOOL.into(),
        description: format!(
            "Read one file that a skill ships, addressed by a path relative to the skill directory \
             exactly as `use_skill` listed it (for example `references/rules.md`). Only text files \
             inside that skill directory can be read; files over 1 MiB, binary files and paths that \
             leave the skill directory are refused. {READ_IS_NOT_EXECUTION_NOTICE} Reading a script's \
             source is informational only."
        )
        .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "skill": skill_argument("Exact skill name as shown in the skill listing"),
                "source": source_argument(),
                "relativePath": {
                    "type": "string",
                    "description": "Path relative to the skill directory, as listed by use_skill"
                }
            },
            "required": ["skill", "relativePath"]
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// Which skill the model asked for.
#[derive(Debug)]
struct SkillTarget {
    name: String,
    source: Option<String>,
}

impl SkillTarget {
    fn from_tool_call(tool_call: &ToolCall) -> Result<Self, String> {
        let name = required_argument(tool_call, "skill")?;
        let source = match tool_call.arguments.get("source") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => match value.trim() {
                "" => None,
                "default" | "custom" => Some(value.trim().to_string()),
                other => {
                    return Err(format!("`source` must be \"default\" or \"custom\", not \"{other}\""));
                }
            },
            Some(_) => return Err("`source` must be a string".to_string()),
        };
        Ok(Self { name, source })
    }
}

fn required_argument(tool_call: &ToolCall, key: &str) -> Result<String, String> {
    tool_call
        .arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("`{key}` is required"))
}

pub async fn execute_use_skill(tool_call: &ToolCall, state: &AppState) -> Result<String, String> {
    let target = SkillTarget::from_tool_call(tool_call)?;
    let roots = load_skill_roots(state).await;
    run_blocking(move || Ok(use_skill_answer(&target, &roots))).await
}

pub async fn execute_read_skill_file(tool_call: &ToolCall, state: &AppState) -> Result<String, String> {
    let target = SkillTarget::from_tool_call(tool_call)?;
    let relative = required_argument(tool_call, "relativePath")?;
    let roots = load_skill_roots(state).await;
    run_blocking(move || read_skill_file_answer(&target, &relative, &roots)).await
}

/// Reading a skill scans directories and reads files up to 1 MiB, so it must not
/// run on the async runtime. Both callers are inside a Tokio runtime (the Tauri
/// command and the web server's per-run runtime).
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|error| format!("Skill tool task failed: {error}"))?
}

/// Roots come from the persisted settings, not from the request: the model (or a
/// stale request) cannot widen which roots are scanned, and the custom root stays
/// inert while its Settings switch is off. A failed settings read degrades to the
/// default root only.
async fn load_skill_roots(state: &AppState) -> SkillRoots {
    let (custom_root_enabled, custom_root) = match state.storage.load_desktop_settings().await {
        Ok(settings) => (settings.custom_ai_skill_root_enabled, settings.custom_ai_skill_root),
        Err(error) => {
            log::warn!("[agent][skills] cannot read the skill root settings; using the default root only: {error}");
            (false, None)
        }
    };
    match tokio::task::spawn_blocking(move || SkillRoots::resolve(custom_root_enabled, custom_root.as_deref())).await {
        Ok(roots) => roots,
        Err(error) => {
            log::warn!("[agent][skills] skill root resolution failed: {error}");
            SkillRoots { default: None, custom: None }
        }
    }
}

fn use_skill_answer(target: &SkillTarget, roots: &SkillRoots) -> String {
    match skills::read_skill_by_name(&target.name, target.source.as_deref(), roots) {
        SkillLookup::Found(skill) => format_skill(&skill),
        SkillLookup::Ambiguous(candidates) => ambiguous_answer(&target.name, &candidates),
        SkillLookup::NotFound => not_found_answer(&target.name, roots),
    }
}

fn read_skill_file_answer(target: &SkillTarget, relative: &str, roots: &SkillRoots) -> Result<String, String> {
    let skill = match skills::read_skill_by_name(&target.name, target.source.as_deref(), roots) {
        SkillLookup::Found(skill) => skill,
        // Retrying with the right skill is the model's job; a wrong or missing
        // skill is answered exactly like `use_skill` would, so one recovery
        // instruction serves both tools.
        SkillLookup::Ambiguous(candidates) => return Err(ambiguous_answer(&target.name, &candidates)),
        SkillLookup::NotFound => return Err(not_found_answer(&target.name, roots)),
    };
    skills::read_skill_file_relative(&skill.dir, relative).map_err(|reason| {
        // The reason is a frozen word from `skills`; the OS detail behind it is
        // discarded there because it carries paths.
        log::debug!("[agent][skills] read_skill_file refused for skill '{}': {reason}", skill.name);
        read_failure_message(&reason)
    })
}

fn format_skill(skill: &ResolvedSkill) -> String {
    let listing = skills::list_skill_files(&skill.dir);
    let mut output = format!(
        "# Skill: {} [{}]\n\n{}\n\n## Files in this skill\n",
        skill.name,
        skill.source,
        skill.content.trim_end()
    );
    if listing.entries.is_empty() {
        output.push_str("(this skill ships no extra files)\n");
    }
    for entry in &listing.entries {
        let kind = if entry.text { "[text]" } else { "[binary]" };
        output.push_str(&format!("- {} ({} bytes) {kind}\n", entry.relative_path, entry.bytes));
    }
    if listing.truncated {
        // A capped listing must say so, or the model reads a partial file list
        // as the whole skill.
        output.push_str(&format!(
            "(the file list is truncated at {} entries; this skill ships more)\n",
            skills::SKILL_LISTING_MAX_ENTRIES
        ));
    }
    output.push_str(
        "\nFollow this skill's instructions. Use `read_skill_file` with one of these relative paths when \
         you need a file the skill references.\n",
    );
    output
}

/// The ambiguous-name answer lists the candidates and stops there: picking one
/// would be a silent wrong-skill answer, and skill names genuinely do live in
/// both roots.
fn ambiguous_answer(name: &str, candidates: &[SkillCandidate]) -> String {
    let mut output =
        format!("Several skills are named \"{name}\". Call this tool again with `source` set to one of:\n");
    for candidate in candidates {
        output.push_str(&format!(
            "- {} [{}]: {}\n",
            candidate.name,
            candidate.source,
            truncate_chars(&candidate.description, MAX_CANDIDATE_DESCRIPTION_CHARS)
        ));
    }
    output
}

fn not_found_answer(name: &str, roots: &SkillRoots) -> String {
    let catalog = skills::list_skill_candidates(roots);
    if catalog.is_empty() {
        return format!(
            "No skill is named \"{name}\", and no skills are available right now. Continue without a skill."
        );
    }
    // Names and sources only: the model already has the descriptions in the
    // listing, and this answer must stay cheap and path-free.
    let mut output = format!("No skill is named \"{name}\". Available skills:\n");
    for candidate in catalog.iter().take(MAX_CATALOG_ENTRIES) {
        output.push_str(&format!("- {} [{}]\n", candidate.name, candidate.source));
    }
    if catalog.len() > MAX_CATALOG_ENTRIES {
        output.push_str("(the list is truncated)\n");
    }
    output.push_str(
        "\nCall this tool again with one of those names, and pass `source` when the name is listed under both sources.",
    );
    output
}

/// Turns a frozen reason into something the model can act on. No OS text and no
/// path: every branch is a fixed string.
fn read_failure_message(reason: &str) -> String {
    let detail = match reason {
        "oversized" => "it is larger than the 1 MiB limit for skill files",
        "not_utf8" => "it is not valid UTF-8 text",
        "not_text" => "it looks binary (it contains a NUL byte), so only text files can be read",
        "unreadable" => "it could not be read",
        "root_unavailable" => "the skill root is not available",
        _ => "no such file exists in this skill directory",
    };
    format!("The skill file could not be read: {detail}.")
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};

    const SKILL_BODY: &str = "---\nname: %NAME%\ndescription: %DESC%\n---\n\nFollow these rules.\n";

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dbx-skill-tools-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_skill(root: &Path, dir: &str, name: &str, description: &str) -> PathBuf {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let body = SKILL_BODY.replace("%NAME%", name).replace("%DESC%", description);
        std::fs::write(dir.join(skills::SKILL_FILE_NAME), body).unwrap();
        dir
    }

    fn roots_of(default: &Path, custom: Option<&Path>) -> SkillRoots {
        SkillRoots {
            default: Some(std::fs::canonicalize(default).unwrap()),
            custom: custom.map(|path| std::fs::canonicalize(path).unwrap()),
        }
    }

    fn call(name: &str, arguments: Value) -> ToolCall {
        ToolCall { id: "call-1".to_string(), name: name.to_string(), arguments, provider_payload: None }
    }

    fn target(name: &str, source: Option<&str>) -> SkillTarget {
        SkillTarget { name: name.to_string(), source: source.map(str::to_string) }
    }

    /// Requirement 11: no tool result may carry a filesystem path. Both spellings
    /// are checked because the canonical form embeds the plain one as a substring,
    /// so a naive containment check against the canonical path alone would miss a
    /// leak of the plain path. On Windows a leaked absolute path always brings a
    /// backslash, and relative paths are normalized to `/`.
    fn assert_no_path_leak(text: &str, roots: &[&Path]) {
        assert!(!text.contains('\\'), "a backslash can only come from a real path: {text}");
        for root in roots {
            let plain = root.to_string_lossy().to_string();
            assert!(!text.contains(&plain), "the skill root leaked: {text}");
            let canonical = std::fs::canonicalize(root).unwrap().to_string_lossy().to_string();
            assert!(!text.contains(&canonical), "the canonical skill root leaked: {text}");
        }
    }

    #[test]
    fn tool_definitions_are_read_only_parallel_and_state_the_execution_boundary() {
        let definitions = tool_definitions();
        let names: Vec<&str> = definitions.iter().map(|definition| definition.name.as_ref()).collect();
        assert_eq!(names, [USE_SKILL_TOOL, READ_SKILL_FILE_TOOL]);
        for definition in &definitions {
            assert!(definition.read_only, "{} must be read-only", definition.name);
            assert!(definition.parallel_ok, "{} must stay parallel-safe", definition.name);
            assert!(
                definition.description.contains(READ_IS_NOT_EXECUTION_NOTICE),
                "{} must carry the no-execution notice verbatim",
                definition.name
            );
            assert!(definition.description.contains("informational only"), "{}", definition.name);
            // The schema is the only place the model learns how to address a
            // skill, and it must never invite a path.
            assert!(definition.parameters.pointer("/properties/skill").is_some());
            assert!(definition.parameters["required"].as_array().unwrap().contains(&json!("skill")));
        }
        let read = definitions.iter().find(|definition| definition.name == READ_SKILL_FILE_TOOL).unwrap();
        assert_eq!(read.parameters["properties"]["source"]["enum"], json!(["default", "custom"]));
        assert!(read.parameters["required"].as_array().unwrap().contains(&json!("relativePath")));
    }

    #[test]
    fn use_skill_reads_a_unique_name_and_lists_referencing_files_by_relative_path() {
        let root = temp_root("use");
        let dir = write_skill(&root, "alpha", "sql-review", "review rules");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("references").join("one.md"), "one").unwrap();
        std::fs::write(dir.join("script.py"), "print(1)").unwrap();
        std::fs::write(dir.join("logo.png"), [0x89u8, b'P', 0, 1]).unwrap();
        let roots = roots_of(&root, None);

        let answer = use_skill_answer(&target("sql-review", None), &roots);
        assert!(answer.contains("Follow these rules."), "the body must be returned: {answer}");
        assert!(answer.contains("references/one.md (3 bytes) [text]"), "{answer}");
        assert!(answer.contains("script.py (8 bytes) [text]"), "{answer}");
        assert!(answer.contains("logo.png (4 bytes) [binary]"), "{answer}");
        assert!(answer.contains("read_skill_file"), "the answer must say how to read them");
        assert_no_path_leak(&answer, &[&root]);
    }

    #[test]
    fn use_skill_says_when_the_file_listing_is_truncated() {
        let root = temp_root("truncated");
        let dir = write_skill(&root, "many", "many-files", "d");
        for index in 0..skills::SKILL_LISTING_MAX_ENTRIES + 3 {
            std::fs::write(dir.join(format!("file-{index:03}.md")), "x").unwrap();
        }
        let roots = roots_of(&root, None);

        let answer = use_skill_answer(&target("many-files", None), &roots);
        assert!(answer.contains("truncated"), "{answer}");
        // SKILL.md is one of the capped entries; every listed file here is text.
        assert_eq!(answer.matches(" bytes) [text]").count(), skills::SKILL_LISTING_MAX_ENTRIES, "{answer}");
    }

    #[test]
    fn use_skill_returns_candidates_instead_of_guessing_between_sources() {
        let root = temp_root("ambiguous");
        write_skill(&root, "one", "shared", "first description");
        let custom = temp_root("ambiguous-custom");
        write_skill(&custom, "two", "shared", "second description");
        let roots = roots_of(&root, Some(&custom));

        let answer = use_skill_answer(&target("shared", None), &roots);
        assert!(answer.contains("shared [default]: first description"), "{answer}");
        assert!(answer.contains("shared [custom]: second description"), "{answer}");
        assert!(answer.contains("`source`"), "the model must be told how to disambiguate: {answer}");
        assert!(!answer.contains("Follow these rules."), "an ambiguous name must not return a body: {answer}");
        assert_no_path_leak(&answer, &[&root, &custom]);

        // The retry with a source resolves it.
        let chosen = use_skill_answer(&target("shared", Some("custom")), &roots);
        assert!(chosen.contains("# Skill: shared [custom]"), "{chosen}");
    }

    #[test]
    fn use_skill_answers_a_missing_name_with_the_catalog() {
        let root = temp_root("missing");
        write_skill(&root, "alpha", "sql-review", "rules");
        let custom = temp_root("missing-custom");
        write_skill(&custom, "beta", "team-rules", "team");
        let roots = roots_of(&root, Some(&custom));

        let answer = use_skill_answer(&target("sql-reveiw", None), &roots);
        assert!(answer.contains("- sql-review [default]"), "{answer}");
        assert!(answer.contains("- team-rules [custom]"), "{answer}");
        assert_no_path_leak(&answer, &[&root, &custom]);

        // No roots at all (default root missing, custom root disabled) is an
        // empty catalog, not a failure.
        let empty = SkillRoots { default: None, custom: None };
        let answer = use_skill_answer(&target("sql-review", None), &empty);
        assert!(answer.contains("no skills are available"), "{answer}");
    }

    #[test]
    fn read_skill_file_returns_a_file_inside_the_skill_directory() {
        let root = temp_root("read");
        let dir = write_skill(&root, "alpha", "sql-review", "rules");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("references").join("one.md"), "reference body").unwrap();
        let roots = roots_of(&root, None);

        let content = read_skill_file_answer(&target("sql-review", None), "references/one.md", &roots).unwrap();
        assert_eq!(content, "reference body");
        assert!(read_skill_file_answer(&target("sql-review", None), "SKILL.md", &roots)
            .unwrap()
            .contains("name: sql-review"));
    }

    #[test]
    fn read_skill_file_refuses_escapes_absolutes_and_unreadable_files() {
        let root = temp_root("reject");
        let dir = write_skill(&root, "alpha", "sql-review", "rules");
        std::fs::write(root.join("outside.md"), "outside body").unwrap();
        let roots = roots_of(&root, None);
        let skill = target("sql-review", None);

        for escape in
            ["../outside.md", "references/../../outside.md", "..\\outside.md", "/etc/hosts", "C:\\Windows\\win.ini"]
        {
            let error = read_skill_file_answer(&skill, escape, &roots).unwrap_err();
            assert!(error.contains("no such file"), "{escape:?} must be refused: {error}");
            assert!(!error.contains(escape), "an error must not echo the requested path: {error}");
        }
        assert!(read_skill_file_answer(&skill, "references", &roots).is_err(), "a directory is not a file");

        std::fs::write(dir.join("with-nul.md"), b"text\0more").unwrap();
        let error = read_skill_file_answer(&skill, "with-nul.md", &roots).unwrap_err();
        assert!(error.contains("binary"), "{error}");

        // No NUL byte here, so this must reach the encoding check instead of
        // being mistaken for binary.
        std::fs::write(dir.join("broken.md"), [0xFFu8, 0xFE]).unwrap();
        assert!(read_skill_file_answer(&skill, "broken.md", &roots).unwrap_err().contains("UTF-8"));

        let big = dir.join("big.md");
        std::fs::write(&big, "x").unwrap();
        std::fs::OpenOptions::new().write(true).open(&big).unwrap().set_len(skills::MAX_SKILL_FILE_BYTES + 1).unwrap();
        assert!(read_skill_file_answer(&skill, "big.md", &roots).unwrap_err().contains("1 MiB"));
    }

    /// The tool layer must hand the *canonical skill directory* to the
    /// containment check — a root-prefix check would accept this junction, since
    /// both directories do live under the root. Windows equivalent of the unix
    /// `symlink` test in `skills::tests`; see the note there for what a junction
    /// cannot cover.
    #[cfg(windows)]
    #[test]
    fn read_skill_file_cannot_follow_a_junction_out_of_the_skill_directory() {
        let root = temp_root("junction");
        let dir = write_skill(&root, "alpha", "sql-review", "rules");
        let outside = temp_root("junction-outside");
        std::fs::write(outside.join("secret.md"), "secret").unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(dir.join("linkdir"))
            .arg(&outside)
            .output()
            .expect("cmd must be runnable to create a junction");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

        let roots = roots_of(&root, None);
        let error = read_skill_file_answer(&target("sql-review", None), "linkdir/secret.md", &roots).unwrap_err();
        assert!(error.contains("no such file"), "{error}");

        let answer = use_skill_answer(&target("sql-review", None), &roots);
        assert!(!answer.contains("linkdir"), "the listing must not advertise a link that leaves the skill: {answer}");
    }

    #[test]
    fn arguments_are_validated_before_any_filesystem_work() {
        assert_eq!(SkillTarget::from_tool_call(&call(USE_SKILL_TOOL, json!({}))).unwrap_err(), "`skill` is required");
        assert_eq!(
            SkillTarget::from_tool_call(&call(USE_SKILL_TOOL, json!({ "skill": "   " }))).unwrap_err(),
            "`skill` is required"
        );
        assert_eq!(
            SkillTarget::from_tool_call(&call(USE_SKILL_TOOL, json!({ "skill": "a", "source": "bogus" }))).unwrap_err(),
            "`source` must be \"default\" or \"custom\", not \"bogus\""
        );
        assert_eq!(
            SkillTarget::from_tool_call(&call(USE_SKILL_TOOL, json!({ "skill": "a", "source": 7 }))).unwrap_err(),
            "`source` must be a string"
        );
        // An empty or absent source means "no filter", not "no source matches".
        let target =
            SkillTarget::from_tool_call(&call(USE_SKILL_TOOL, json!({ "skill": "a", "source": "  " }))).unwrap();
        assert_eq!(target.name, "a");
        assert!(target.source.is_none());
        assert_eq!(
            required_argument(&call(READ_SKILL_FILE_TOOL, json!({ "skill": "a" })), "relativePath").unwrap_err(),
            "`relativePath` is required"
        );
    }

    #[test]
    fn candidate_descriptions_are_trimmed_to_a_hint() {
        let long = "x".repeat(MAX_CANDIDATE_DESCRIPTION_CHARS + 50);
        let candidates = vec![SkillCandidate { name: "shared".to_string(), source: "default", description: long }];
        let answer = ambiguous_answer("shared", &candidates);
        assert!(answer.contains('…'), "{answer}");
        assert!(answer.len() < MAX_CANDIDATE_DESCRIPTION_CHARS + 200, "{answer}");
    }
}
