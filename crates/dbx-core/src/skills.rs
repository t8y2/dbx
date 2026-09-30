//! Read-only discovery and reading of user-level SKILL.md skills.
//!
//! Two roots are scanned: the default user-level root (HOME/.agents/skills) and
//! an optional user-configured custom root (Settings > AI). The service is
//! strictly read-only: there is no create/write/delete API. Skills are
//! identified by deterministic opaque ids derived from the root source and the
//! canonical relative skill directory name, so ids survive Refresh (prd.md:34).
//! Absolute paths never leave this module (prd.md:33).
//!
//! Lives in `dbx-core` rather than beside the Tauri commands because the AI
//! agent loop needs the same discovery and path-boundary logic
//! (prd 09-30-skill-listing-use-skill). `src-tauri/src/commands/user_skills.rs`
//! is a thin adapter over [`list_skills`] / [`read_skills`]; there must be
//! exactly one implementation of the containment rules, since a second copy is
//! a second place for a symlink escape to be missed.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SKILL_FILE_NAME: &str = "SKILL.md";
/// Hard per-file safety limit: a larger SKILL.md is invalid and omitted from
/// discovery, and blocks the send when selected (prd.md:26/:37).
pub const MAX_SKILL_FILE_BYTES: u64 = 1_048_576;
/// Send-time reads take at most 1 MiB + 1 byte so a file that grows after the
/// metadata check is rejected instead of loaded unboundedly (prd.md:38).
const READ_LIMIT_BYTES: u64 = MAX_SKILL_FILE_BYTES + 1;
/// The opening frontmatter block must close within the first 64 KiB.
const FRONTMATTER_SCAN_BYTES: usize = 64 * 1024;

const DEFAULT_ROOT_PREFIX: &str = "d";
const CUSTOM_ROOT_PREFIX: &str = "c";

const ROOT_STATUS_OK: &str = "ok";
const ROOT_STATUS_MISSING: &str = "missing";
const ROOT_STATUS_INVALID: &str = "invalid";

/// Bounded failure vocabulary. Underlying I/O detail (which can contain
/// absolute paths or OS-specific text) is deliberately discarded rather than
/// forwarded, so nothing path-shaped reaches the frontend (prd.md:33).
const REASON_NOT_FOUND: &str = "not_found";
const REASON_ROOT_UNAVAILABLE: &str = "root_unavailable";
const REASON_OVERSIZED: &str = "oversized";
const REASON_NOT_UTF8: &str = "not_utf8";
const REASON_INVALID_FRONTMATTER: &str = "invalid_frontmatter";
const REASON_UNREADABLE: &str = "unreadable";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillMeta {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillRootListing {
    /// One of "ok" | "missing" | "invalid".
    pub status: String,
    pub skills: Vec<UserSkillMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillsListResult {
    pub default_root: UserSkillRootListing,
    pub custom_root: Option<UserSkillRootListing>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadUserSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadUserSkillFailure {
    pub id: String,
    /// One of "not_found" | "root_unavailable" | "oversized" | "not_utf8" | "invalid_frontmatter" | "unreadable".
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillsReadResult {
    pub skills: Vec<ReadUserSkill>,
    pub failures: Vec<ReadUserSkillFailure>,
}

/// Lists skill metadata for both roots. The default root is always scanned;
/// the custom root only when it is enabled in Settings (prd.md:27). An absent
/// root yields an empty listing rather than an error (prd.md:35).
///
/// Blocking filesystem work: callers offload it to a blocking pool.
pub fn list_skills(custom_root_enabled: bool, custom_root: Option<&str>) -> UserSkillsListResult {
    let default_root = match default_skills_root() {
        Some(path) => root_listing(&path, DEFAULT_ROOT_PREFIX),
        None => empty_listing(ROOT_STATUS_MISSING),
    };
    let custom_root = if custom_root_enabled {
        enabled_custom_root(custom_root).map(|path| root_listing(&path, CUSTOM_ROOT_PREFIX))
    } else {
        None
    };
    UserSkillsListResult { default_root, custom_root }
}

/// Reads the currently selected skills by id. Every id is resolved only
/// through re-derivation over a fresh scan of the owning root, so a deleted,
/// moved, or root-escaping skill fails instead of silently resolving to a
/// stale path (prd.md:37).
///
/// Blocking filesystem work: callers offload it to a blocking pool.
pub fn read_skills(ids: &[String], custom_root_enabled: bool, custom_root: Option<&str>) -> UserSkillsReadResult {
    let roots = SkillRoots::resolve(custom_root_enabled, custom_root);
    read_user_skills_from(ids, roots.default.as_deref(), roots.custom.as_deref())
}

/// Root resolution is injected so tests can exercise both roots without
/// depending on the developer home directory.
fn read_user_skills_from(
    ids: &[String],
    default_root: Option<&Path>,
    custom_root: Option<&Path>,
) -> UserSkillsReadResult {
    let mut skills = Vec::new();
    let mut failures = Vec::new();
    let mut seen_ids: HashSet<&str> = HashSet::new();
    for id in ids {
        // A repeated id must not inject the same skill text twice.
        if !seen_ids.insert(id.as_str()) {
            continue;
        }
        let prefix = match id.split_once('-') {
            Some((prefix, _)) if prefix == DEFAULT_ROOT_PREFIX || prefix == CUSTOM_ROOT_PREFIX => prefix,
            _ => {
                failures.push(ReadUserSkillFailure { id: id.clone(), reason: REASON_NOT_FOUND.to_string() });
                continue;
            }
        };
        let root = match prefix {
            DEFAULT_ROOT_PREFIX => default_root,
            _ => custom_root,
        };
        let Some(root) = root else {
            failures.push(ReadUserSkillFailure { id: id.clone(), reason: REASON_ROOT_UNAVAILABLE.to_string() });
            continue;
        };
        match read_skill_from_root(root, prefix, id) {
            Ok(skill) => skills.push(skill),
            Err(reason) => failures.push(ReadUserSkillFailure { id: id.clone(), reason }),
        }
    }
    UserSkillsReadResult { skills, failures }
}

fn enabled_custom_root(custom_root: Option<&str>) -> Option<PathBuf> {
    let trimmed = custom_root.map(str::trim).filter(|value| !value.is_empty())?;
    let canonical = std::fs::canonicalize(trimmed).ok()?;
    canonical.is_dir().then_some(canonical)
}

fn default_skills_root() -> Option<PathBuf> {
    Some(home_dir()?.join(".agents").join("skills"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().map(PathBuf::from)
}

fn empty_listing(status: &str) -> UserSkillRootListing {
    UserSkillRootListing { status: status.to_string(), skills: Vec::new() }
}

fn root_listing(path: &Path, prefix: &str) -> UserSkillRootListing {
    match std::fs::canonicalize(path) {
        Ok(canonical) if canonical.is_dir() => {
            UserSkillRootListing { status: ROOT_STATUS_OK.to_string(), skills: scan_root(&canonical, prefix) }
        }
        Ok(_) => empty_listing(ROOT_STATUS_INVALID),
        Err(_) => empty_listing(ROOT_STATUS_MISSING),
    }
}

/// Scans the direct children of a canonical root. Symlink policy (prd.md:40):
/// an entry is only discoverable when its canonical target stays inside the
/// root, so a symlink that escapes the root is invisible to discovery.
///
/// The containment rules themselves live in [`scan_root_entries`]; this is only
/// the id-projection plus the listing order.
fn scan_root(canonical_root: &Path, prefix: &str) -> Vec<UserSkillMeta> {
    let mut skills: Vec<UserSkillMeta> = scan_root_entries(canonical_root)
        .into_iter()
        .map(|entry| UserSkillMeta {
            id: skill_id(prefix, &entry.dir_name),
            name: entry.name,
            description: entry.description,
        })
        .collect();
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    skills
}

/// Listing reads only the head of the file: the size gate plus a bounded
/// prefix read are enough to parse the opening frontmatter block
/// (prd.md:26 - "parse their frontmatter according to the public convention").
/// The body is never read here (prd.md:56).
fn discover_skill_metadata(path: &Path) -> Option<(String, String)> {
    let stat = std::fs::metadata(path).ok()?;
    if !stat.is_file() || stat.len() > MAX_SKILL_FILE_BYTES {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(FRONTMATTER_SCAN_BYTES as u64).read_to_end(&mut bytes).ok()?;
    parse_frontmatter(decode_prefix(&bytes, stat.len())?)
}

/// Decodes the bounded listing prefix strictly, so an unreadable file is not
/// offered as a choice (it would always fail at send time). A multi-byte
/// character cut by the prefix read is not an encoding error: when the file
/// continues past the prefix, the trailing partial character is trimmed. The
/// bytes beyond the prefix stay unvalidated here and are checked at send time.
fn decode_prefix(bytes: &[u8], file_len: u64) -> Option<&str> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(error) if error.error_len().is_none() && file_len > bytes.len() as u64 => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    }
}

/// Reads and fully validates one selected skill file. The metadata size check
/// is followed by a 1 MiB + 1 byte bounded read, so a file that grows between
/// the two is rejected as oversized instead of loaded unboundedly (prd.md:38).
fn read_skill_from_root(canonical_root: &Path, prefix: &str, id: &str) -> Result<ReadUserSkill, String> {
    for entry in contained_skill_dirs(canonical_root) {
        if skill_id(prefix, &entry.dir_name) != id {
            continue;
        }
        let resolved = read_contained_skill(canonical_root, prefix, &entry.dir_name, &entry.dir)?;
        return Ok(ReadUserSkill {
            id: resolved.id,
            name: resolved.name,
            description: resolved.description,
            content: resolved.content,
        });
    }
    Err(REASON_NOT_FOUND.to_string())
}

fn read_skill_file(path: &Path, id: &str) -> Result<ReadUserSkill, String> {
    let stat = std::fs::metadata(path).map_err(|_| REASON_NOT_FOUND.to_string())?;
    if !stat.is_file() {
        return Err(REASON_NOT_FOUND.to_string());
    }
    if stat.len() > MAX_SKILL_FILE_BYTES {
        return Err(REASON_OVERSIZED.to_string());
    }
    let file = std::fs::File::open(path).map_err(|_| REASON_UNREADABLE.to_string())?;
    let mut bytes = Vec::new();
    file.take(READ_LIMIT_BYTES).read_to_end(&mut bytes).map_err(|_| REASON_UNREADABLE.to_string())?;
    if bytes.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err(REASON_OVERSIZED.to_string());
    }
    let text = String::from_utf8(bytes).map_err(|_| REASON_NOT_UTF8.to_string())?;
    let (name, description) = parse_frontmatter(&text).ok_or_else(|| REASON_INVALID_FRONTMATTER.to_string())?;
    Ok(ReadUserSkill { id: id.to_string(), name, description, content: text })
}

/// Deterministic opaque id: root source prefix plus a truncated SHA-256 of the
/// canonical relative skill directory name. Stable across Refresh and restarts
/// of the registry (prd.md:34). The id carries no path material to the client.
fn skill_id(prefix: &str, dir_name: &str) -> String {
    let digest = Sha256::digest(dir_name.as_bytes());
    let mut id = String::from(prefix);
    id.push('-');
    for byte in &digest[..8] {
        id.push_str(&format!("{:02x}", byte));
    }
    id
}

/// Parses the opening YAML frontmatter block per the public SKILL.md
/// convention: required non-empty name and description, unknown keys ignored.
/// Returns None when the block is missing, unclosed, oversized, or lacks a
/// required field (prd.md:26/:52).
fn parse_frontmatter(text: &str) -> Option<(String, String)> {
    let text = text.strip_prefix("\u{feff}").unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut block = String::new();
    let mut closed = false;
    for line in lines {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        block.push_str(line);
        block.push('\n');
        if block.len() > FRONTMATTER_SCAN_BYTES {
            return None;
        }
    }
    if !closed {
        return None;
    }
    let frontmatter: SkillFrontmatter = serde_yaml_ng::from_str(&block).ok()?;
    let name = frontmatter.name?.trim().to_string();
    let description = frontmatter.description?.trim().to_string();
    if name.is_empty() || description.is_empty() {
        return None;
    }
    Some((name, description))
}

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

// ── Roots, name resolution and referencing files ──────────────────────────
//
// Added for the AI agent's `use_skill` / `read_skill_file` tools
// (prd 09-30-skill-listing-use-skill, Requirements 8-11b). Two rules hold for
// everything below:
//   * the boundary is the CANONICALIZED SKILL DIRECTORY, not the root prefix,
//     and it is re-validated on every read — a check done only at scan time
//     leaks the first time a path is swapped underneath us;
//   * no absolute path may leave this module. The agent sees relative paths.

/// Source label used in the listing and the tool arguments. Deliberately the
/// words the prompt shows (`[default]` / `[custom]`), so the model can pass back
/// exactly what it read.
const SOURCE_DEFAULT: &str = "default";
const SOURCE_CUSTOM: &str = "custom";

/// The referencing-file listing is bounded in both directions: a skill may ship
/// hundreds of files (measured: up to 60+ on this machine), and an unbounded
/// listing would spend the tool result on paths.
pub const SKILL_LISTING_MAX_ENTRIES: usize = 50;
pub const SKILL_LISTING_MAX_DEPTH: usize = 4;
/// Binary classification sniffs a prefix rather than reading the file twice.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Directories that only ever hold build output or vendored dependencies.
const SKIPPED_DIR_NAMES: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__", "venv"];

const REASON_NOT_TEXT: &str = "not_text";

fn source_label(prefix: &str) -> &'static str {
    if prefix == CUSTOM_ROOT_PREFIX {
        SOURCE_CUSTOM
    } else {
        SOURCE_DEFAULT
    }
}

/// Canonicalized skill roots. The agent tools resolve roots here instead of
/// accepting a path from the caller, so every containment check below has one
/// trusted origin.
pub struct SkillRoots {
    pub default: Option<PathBuf>,
    pub custom: Option<PathBuf>,
}

impl SkillRoots {
    pub fn resolve(custom_root_enabled: bool, custom_root: Option<&str>) -> Self {
        let default =
            default_skills_root().and_then(|path| std::fs::canonicalize(&path).ok()).filter(|path| path.is_dir());
        let custom = if custom_root_enabled { enabled_custom_root(custom_root) } else { None };
        Self { default, custom }
    }

    fn iter(&self) -> impl Iterator<Item = (&'static str, &Path)> {
        [(DEFAULT_ROOT_PREFIX, self.default.as_deref()), (CUSTOM_ROOT_PREFIX, self.custom.as_deref())]
            .into_iter()
            .filter_map(|(prefix, root)| root.map(|root| (prefix, root)))
    }
}

/// One discoverable skill, with the directory the tools need. Kept private: the
/// directory must not escape, so callers get [`ResolvedSkill`] instead.
struct ScannedSkill {
    dir_name: String,
    name: String,
    description: String,
    dir: PathBuf,
}

/// A skill the model asked for by name, already read in full.
pub struct ResolvedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub source: &'static str,
    /// Canonical skill directory. Stays inside this module (Requirement 11).
    pub dir: PathBuf,
}

/// One candidate of an ambiguous name, shown back to the model so it can retry
/// with a `source` instead of the tool guessing between two real skills.
pub struct SkillCandidate {
    pub name: String,
    pub source: &'static str,
    pub description: String,
}

pub enum SkillLookup {
    Found(Box<ResolvedSkill>),
    Ambiguous(Vec<SkillCandidate>),
    NotFound,
}

/// One directory under a canonical root that obeys the symlink policy. This is
/// the *only* implementation of the containment rules — the discovery scan, the
/// id read and the name read all start here, so a policy fix cannot land in one
/// path and miss another.
struct ContainedSkillDir {
    dir_name: String,
    dir: PathBuf,
}

fn contained_skill_dirs(canonical_root: &Path) -> Vec<ContainedSkillDir> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(canonical_root) else { return found };
    for entry in entries.flatten() {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if dir_name.starts_with('.') {
            continue;
        }
        let Ok(canonical_dir) = entry.path().canonicalize() else { continue };
        if !canonical_dir.starts_with(canonical_root) || !canonical_dir.is_dir() {
            continue;
        }
        let skill_file = canonical_dir.join(SKILL_FILE_NAME);
        let Ok(canonical_skill_file) = skill_file.canonicalize() else { continue };
        // A skill directory may be linked within the allowed root, but its
        // entry file must obey the same containment rule. Otherwise a normal
        // directory could hide a SKILL.md symlink to an arbitrary local file.
        if !canonical_skill_file.starts_with(canonical_root) {
            continue;
        }
        found.push(ContainedSkillDir { dir_name, dir: canonical_dir });
    }
    found
}

/// The *discoverable* skills: contained directories whose SKILL.md yields usable
/// frontmatter metadata. Discovery is deliberately NOT part of the read path —
/// see [`read_contained_skill`] — so a file that fails discovery still reports
/// its own reason (`not_utf8`, `oversized`) when read by id, which is what the
/// frozen reason vocabulary and its user-facing copy promise.
fn scan_root_entries(canonical_root: &Path) -> Vec<ScannedSkill> {
    let mut found = Vec::new();
    for ContainedSkillDir { dir_name, dir } in contained_skill_dirs(canonical_root) {
        let Some((name, description)) = discover_skill_metadata(&dir.join(SKILL_FILE_NAME)) else { continue };
        found.push(ScannedSkill { dir_name, name, description, dir });
    }
    found
}

/// Reads one contained skill directory, re-validating its entry file against the
/// root at read time. The scan-time verdict can be stale by the time a send or a
/// tool call arrives (another process may have swapped SKILL.md for an escaping
/// symlink), and the boundary is the canonical skill directory — not the root
/// prefix — so the check is against the root the entry actually came from.
///
/// Takes the directory rather than a discovered entry on purpose: the read path
/// must not inherit discovery's gate, or a file that failed discovery would be
/// reported as `not_found` instead of its real reason.
fn read_contained_skill(
    canonical_root: &Path,
    prefix: &str,
    dir_name: &str,
    dir: &Path,
) -> Result<ResolvedSkill, String> {
    let id = skill_id(prefix, dir_name);
    let canonical_skill_file = dir.join(SKILL_FILE_NAME).canonicalize().map_err(|_| REASON_NOT_FOUND.to_string())?;
    if !canonical_skill_file.starts_with(canonical_root) {
        return Err(REASON_NOT_FOUND.to_string());
    }
    let skill = read_skill_file(&canonical_skill_file, &id)?;
    Ok(ResolvedSkill {
        id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        source: source_label(prefix),
        dir: dir.to_path_buf(),
    })
}

/// Resolves a skill by the name the listing showed the model.
///
/// Matching is exact on purpose: the listing prints the frontmatter name
/// verbatim, and a fuzzy matcher would turn "did you mean" into a silent wrong
/// skill. `source` disambiguates the genuinely common case of one name living in
/// both roots; when the name is still ambiguous the caller gets the candidates
/// rather than a coin flip (Requirement 8).
pub fn read_skill_by_name(name: &str, source: Option<&str>, roots: &SkillRoots) -> SkillLookup {
    let wanted = name.trim();
    if wanted.is_empty() {
        return SkillLookup::NotFound;
    }
    let mut matches: Vec<(&'static str, PathBuf, ScannedSkill)> = Vec::new();
    for (prefix, root) in roots.iter() {
        if source.is_some_and(|source| source != source_label(prefix)) {
            continue;
        }
        for entry in scan_root_entries(root) {
            if entry.name == wanted {
                matches.push((prefix, root.to_path_buf(), entry));
            }
        }
    }
    match matches.len() {
        0 => SkillLookup::NotFound,
        1 => {
            let (prefix, root, entry) = matches.remove(0);
            // A skill that passed discovery can still fail the read-time gate
            // (oversized after growth, encoding, vanished). Reported as
            // not-found so no absolute path reaches the model.
            match read_contained_skill(&root, prefix, &entry.dir_name, &entry.dir) {
                Ok(skill) => SkillLookup::Found(Box::new(skill)),
                Err(_) => SkillLookup::NotFound,
            }
        }
        _ => SkillLookup::Ambiguous(
            matches
                .into_iter()
                .map(|(prefix, _root, entry)| SkillCandidate {
                    name: entry.name,
                    source: source_label(prefix),
                    description: entry.description,
                })
                .collect(),
        ),
    }
}

/// Every discoverable skill as name + source + description, in root order
/// (default, then custom) and name order inside a root. The recovery answer of a
/// failed name lookup prints the names and sources from here, and nothing else:
/// the agent must never see a path.
pub fn list_skill_candidates(roots: &SkillRoots) -> Vec<SkillCandidate> {
    let mut candidates = Vec::new();
    for (prefix, root) in roots.iter() {
        candidates.extend(scan_root_entries(root).into_iter().map(|entry| SkillCandidate {
            name: entry.name,
            source: source_label(prefix),
            description: entry.description,
        }));
    }
    candidates
}

/// One entry of a skill's referencing-file listing. `bytes` and `text` are what
/// let the model decide whether reading the file is worth a second tool call.
pub struct SkillFileEntry {
    pub relative_path: String,
    pub bytes: u64,
    pub text: bool,
}

pub struct SkillFileListing {
    pub entries: Vec<SkillFileEntry>,
    pub truncated: bool,
}

fn is_binary_prefix(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn sniff_is_text(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return true };
    let mut prefix = Vec::new();
    if file.take(BINARY_SNIFF_BYTES as u64).read_to_end(&mut prefix).is_err() {
        return true;
    }
    !is_binary_prefix(&prefix)
}

/// Lists the files a skill ships beside its SKILL.md, relative to the skill
/// directory, skipping hidden entries and build/vendor directories. Both the
/// depth and the entry count are capped; `truncated` tells the caller to say so
/// rather than present a partial listing as complete.
pub fn list_skill_files(canonical_dir: &Path) -> SkillFileListing {
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(canonical_dir.to_path_buf(), 0usize)];
    'outer: while let Some((current, depth)) = stack.pop() {
        if depth > SKILL_LISTING_MAX_DEPTH {
            continue;
        }
        let Ok(read) = std::fs::read_dir(&current) else { continue };
        let mut children: Vec<_> = read.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIPPED_DIR_NAMES.contains(&name.as_str()) {
                continue;
            }
            let Ok(canonical) = entry.path().canonicalize() else { continue };
            // Same boundary as the scan: a link that leaves the skill directory
            // is invisible, so the listing cannot advertise an outside path.
            if !canonical.starts_with(canonical_dir) {
                continue;
            }
            let Ok(metadata) = std::fs::metadata(&canonical) else { continue };
            if metadata.is_dir() {
                stack.push((canonical, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if entries.len() >= SKILL_LISTING_MAX_ENTRIES {
                truncated = true;
                break 'outer;
            }
            let Ok(relative) = canonical.strip_prefix(canonical_dir) else { continue };
            entries.push(SkillFileEntry {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                bytes: metadata.len(),
                text: sniff_is_text(&canonical),
            });
        }
    }
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    SkillFileListing { entries, truncated }
}

/// Reads one referencing file inside a skill directory.
///
/// Every rejection is a bounded reason, never an OS error string: those carry
/// absolute paths. `..` and absolute inputs are refused outright rather than
/// left to the containment check, so the intent is explicit and the reason
/// stable. A file containing a NUL byte is classified as binary and refused as
/// `not_text` (Requirement 11a) — reading a file is not permission to run it,
/// and the tool description says so.
pub fn read_skill_file_relative(canonical_dir: &Path, relative: &str) -> Result<String, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err(REASON_NOT_FOUND.to_string());
    }
    let requested = Path::new(trimmed);
    if requested.is_absolute() || trimmed.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(REASON_NOT_FOUND.to_string());
    }
    let canonical = canonical_dir.join(requested).canonicalize().map_err(|_| REASON_NOT_FOUND.to_string())?;
    if !canonical.starts_with(canonical_dir) {
        return Err(REASON_NOT_FOUND.to_string());
    }
    let stat = std::fs::metadata(&canonical).map_err(|_| REASON_NOT_FOUND.to_string())?;
    if !stat.is_file() {
        return Err(REASON_NOT_FOUND.to_string());
    }
    if stat.len() > MAX_SKILL_FILE_BYTES {
        return Err(REASON_OVERSIZED.to_string());
    }
    let file = std::fs::File::open(&canonical).map_err(|_| REASON_UNREADABLE.to_string())?;
    let mut bytes = Vec::new();
    file.take(READ_LIMIT_BYTES).read_to_end(&mut bytes).map_err(|_| REASON_UNREADABLE.to_string())?;
    if bytes.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err(REASON_OVERSIZED.to_string());
    }
    // NUL is valid UTF-8, so this must run before the decode to be reachable.
    if is_binary_prefix(&bytes) {
        return Err(REASON_NOT_TEXT.to_string());
    }
    String::from_utf8(bytes).map_err(|_| REASON_NOT_UTF8.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_BODY: &str = "---\nname: sql-review\ndescription: Team SQL review rules\n---\n\nFollow the rules.\n";

    fn temp_skills_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dbx-user-skills-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_skill(root: &Path, dir: &str, body: &str) -> PathBuf {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SKILL_FILE_NAME), body).unwrap();
        dir
    }

    fn set_file_len(skill_dir: &Path, len: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(skill_dir.join(SKILL_FILE_NAME)).unwrap();
        file.set_len(len).unwrap();
    }

    #[test]
    fn parses_frontmatter_and_ignores_extra_keys() {
        let (name, description) =
            parse_frontmatter("---\nname: \"sql-review\"\ndescription: Team rules\nmetadata:\n  short: x\nallowed-tools: [read]\n---\n\nBody.\n").unwrap();
        assert_eq!(name, "sql-review");
        assert_eq!(description, "Team rules");
    }

    #[test]
    fn frontmatter_must_open_and_close_at_the_top() {
        assert!(parse_frontmatter("name: x\ndescription: y\n").is_none());
        assert!(parse_frontmatter("---\nname: x\ndescription: y\n").is_none());
        assert!(parse_frontmatter("body first\n---\nname: x\ndescription: y\n---\n").is_none());
    }

    #[test]
    fn frontmatter_requires_name_and_description() {
        assert!(parse_frontmatter("---\ndescription: only desc\n---\n").is_none());
        assert!(parse_frontmatter("---\nname: only name\n---\n").is_none());
        assert!(parse_frontmatter("---\nname:\ndescription: y\n---\n").is_none());
        assert!(parse_frontmatter("---\nname: x\ndescription:    \n---\n").is_none());
    }

    #[test]
    fn skill_ids_are_deterministic_and_root_scoped() {
        assert_eq!(skill_id("d", "alpha"), skill_id("d", "alpha"));
        assert_ne!(skill_id("d", "alpha"), skill_id("c", "alpha"));
        assert_ne!(skill_id("d", "alpha"), skill_id("d", "beta"));
        assert!(skill_id("d", "alpha").starts_with("d-"));
        assert_eq!(skill_id("d", "alpha").len(), 18);
    }

    #[test]
    fn scan_lists_valid_skills_and_omits_others() {
        let root = temp_skills_root("scan");
        write_skill(&root, "alpha", VALID_BODY);
        write_skill(&root, "zulu", VALID_BODY);
        write_skill(&root, "nodesc", "---\nname: nodesc\n---\nbody\n");
        write_skill(&root, ".hidden", VALID_BODY);
        let nested = root.join("nested");
        std::fs::create_dir_all(nested.join("deep")).unwrap();
        std::fs::write(nested.join("deep").join(SKILL_FILE_NAME), VALID_BODY).unwrap();
        let oversized = write_skill(&root, "oversized", VALID_BODY);
        set_file_len(&oversized, MAX_SKILL_FILE_BYTES + 1);
        let canonical = std::fs::canonicalize(&root).unwrap();
        let skills = scan_root(&canonical, "d");
        let names: Vec<String> = skills.iter().map(|skill| skill.name.clone()).collect();
        assert_eq!(names, vec!["sql-review", "sql-review"]);
        assert_ne!(skills[0].id, skills[1].id);
        assert!(skills.iter().all(|skill| skill.id.starts_with("d-")));
    }

    #[test]
    fn root_listing_reports_missing_and_invalid() {
        let root = temp_skills_root("listing");
        write_skill(&root, "alpha", VALID_BODY);
        let missing = root_listing(&root.join("does-not-exist"), "d");
        assert_eq!(missing.status, "missing");
        assert!(missing.skills.is_empty());
        let file_marker = root.join("plain-file.txt");
        std::fs::write(&file_marker, "x").unwrap();
        assert_eq!(root_listing(&file_marker, "d").status, "invalid");
        assert_eq!(root_listing(&root, "d").status, "ok");
    }

    #[test]
    fn read_returns_full_content_and_enforces_the_one_mib_boundary() {
        let root = temp_skills_root("read");
        let exact = write_skill(&root, "exact", VALID_BODY);
        set_file_len(&exact, MAX_SKILL_FILE_BYTES);
        let toobig = write_skill(&root, "toobig", VALID_BODY);
        set_file_len(&toobig, MAX_SKILL_FILE_BYTES + 1);
        let canonical = std::fs::canonicalize(&root).unwrap();
        let exact_skill = read_skill_from_root(&canonical, "d", &skill_id("d", "exact")).unwrap();
        assert_eq!(exact_skill.name, "sql-review");
        assert_eq!(exact_skill.content.len(), MAX_SKILL_FILE_BYTES as usize);
        assert_eq!(read_skill_from_root(&canonical, "d", &skill_id("d", "toobig")).unwrap_err(), "oversized");
    }

    #[test]
    fn read_reports_not_found_for_missing_and_root_unavailable_for_disabled_roots() {
        let root = temp_skills_root("missing");
        let skill_dir = write_skill(&root, "gone", VALID_BODY);
        let canonical = std::fs::canonicalize(&root).unwrap();
        let id = skill_id("d", "gone");
        assert!(read_skill_from_root(&canonical, "d", &id).is_ok());
        std::fs::remove_dir_all(skill_dir).unwrap();
        assert_eq!(read_skill_from_root(&canonical, "d", &id).unwrap_err(), "not_found");

        let custom = temp_skills_root("custom");
        write_skill(&custom, "team", VALID_BODY);
        let custom_id = skill_id("c", "team");
        let disabled = read_skills(std::slice::from_ref(&custom_id), false, Some(custom.to_str().unwrap()));
        assert_eq!(disabled.failures.len(), 1);
        assert_eq!(disabled.failures[0].reason, "root_unavailable");
        let vanished = read_skills(&[custom_id], true, Some(custom.join("nope").to_str().unwrap()));
        assert_eq!(vanished.failures[0].reason, "root_unavailable");
    }

    #[test]
    fn read_preserves_request_order_and_collects_failures() {
        // Both roots are injected: a `d-` id resolved through the real home
        // directory would make this test depend on the machine it runs on.
        let root = temp_skills_root("order");
        write_skill(&root, "keep", VALID_BODY);
        std::fs::write(root.join("plain.txt"), "x").unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let result = read_user_skills_from(
            &["d-bogus".to_string(), skill_id("d", "keep"), skill_id("d", "never-existed")],
            Some(&canonical),
            None,
        );
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].id, skill_id("d", "keep"));
        assert_eq!(result.failures.len(), 2);
        assert_eq!(result.failures[0].id, "d-bogus");
        assert_eq!(result.failures[0].reason, "not_found");
        assert_eq!(result.failures[1].reason, "not_found");
    }

    #[test]
    fn read_skips_duplicate_ids() {
        let root = temp_skills_root("dedupe");
        write_skill(&root, "once", VALID_BODY);
        let canonical = std::fs::canonicalize(&root).unwrap();
        let id = skill_id("d", "once");
        let result = read_user_skills_from(&[id.clone(), id.clone(), id], Some(&canonical), None);
        assert_eq!(result.skills.len(), 1);
        assert!(result.failures.is_empty());
        // Deduplication must not swallow a failure: a repeated bad id is
        // still reported exactly once.
        let duplicated_bad = ["d-bogus".to_string(), "d-bogus".to_string()];
        let failed = read_user_skills_from(&duplicated_bad, Some(&canonical), None);
        assert!(failed.skills.is_empty());
        assert_eq!(failed.failures.len(), 1);
        assert_eq!(failed.failures[0].id, "d-bogus");
    }

    #[test]
    fn listing_omits_a_file_that_is_not_valid_utf8() {
        let root = temp_skills_root("invalid-utf8");
        let dir = root.join("broken");
        std::fs::create_dir_all(&dir).unwrap();
        let mut bytes = b"---\nname: br".to_vec();
        bytes.push(0xFF);
        bytes.extend_from_slice(b"oken\ndescription: desc\n---\n\nBody.\n");
        std::fs::write(dir.join(SKILL_FILE_NAME), &bytes).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        assert!(scan_root(&canonical, "d").is_empty());
        assert_eq!(read_skill_from_root(&canonical, "d", &skill_id("d", "broken")).unwrap_err(), "not_utf8");
    }

    #[test]
    fn listing_tolerates_a_multibyte_character_cut_by_the_prefix_read() {
        let root = temp_skills_root("prefix-cut");
        let frontmatter = "---\nname: cut\ndescription: boundary\n---\n";
        let mut body = String::from(frontmatter);
        body.push_str(&"a".repeat(FRONTMATTER_SCAN_BYTES - frontmatter.len() - 1));
        body.push('\u{e9}');
        body.push_str(&"b".repeat(64));
        write_skill(&root, "cut", &body);
        let canonical = std::fs::canonicalize(&root).unwrap();
        let skills = scan_root(&canonical, "d");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "cut");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_policy_allows_inside_root_only() {
        use std::os::unix::fs::symlink;
        let root = temp_skills_root("links");
        write_skill(&root, "real", VALID_BODY);
        symlink(root.join("real"), root.join("inside")).unwrap();
        let outside = temp_skills_root("outside");
        write_skill(&outside, "escapee", VALID_BODY);
        symlink(outside.join("escapee"), root.join("escape")).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let skills = scan_root(&canonical, "d");
        let ids: Vec<String> = skills.iter().map(|skill| skill.id.clone()).collect();
        assert!(ids.contains(&skill_id("d", "inside")));
        assert!(!ids.contains(&skill_id("d", "escape")));
    }

    #[cfg(unix)]
    #[test]
    fn skill_file_symlink_cannot_escape_the_root() {
        use std::os::unix::fs::symlink;

        let root = temp_skills_root("file-link");
        let escape_dir = write_skill(&root, "file-escape", VALID_BODY);
        let outside = temp_skills_root("file-link-outside");
        let outside_file = outside.join("SKILL.md");
        std::fs::write(&outside_file, VALID_BODY).unwrap();
        std::fs::remove_file(escape_dir.join(SKILL_FILE_NAME)).unwrap();
        symlink(&outside_file, escape_dir.join(SKILL_FILE_NAME)).unwrap();

        let canonical = std::fs::canonicalize(&root).unwrap();
        let id = skill_id("d", "file-escape");
        assert!(!scan_root(&canonical, "d").iter().any(|skill| skill.id == id));
        assert_eq!(read_skill_from_root(&canonical, "d", &id).unwrap_err(), REASON_NOT_FOUND);
    }

    // ── name resolution and referencing files (agent tools) ────────────────

    fn write_named_skill(root: &Path, dir: &str, name: &str, description: &str) -> PathBuf {
        write_skill(root, dir, &format!("---\nname: {name}\ndescription: {description}\n---\n\nBody of {name}.\n"))
    }

    fn roots_of(default: &Path, custom: Option<&Path>) -> SkillRoots {
        SkillRoots {
            default: Some(std::fs::canonicalize(default).unwrap()),
            custom: custom.map(|path| std::fs::canonicalize(path).unwrap()),
        }
    }

    #[test]
    fn read_skill_by_name_resolves_a_unique_name_and_reports_its_source() {
        let root = temp_skills_root("byname");
        write_named_skill(&root, "alpha", "sql-review", "review rules");
        let roots = roots_of(&root, None);

        let SkillLookup::Found(skill) = read_skill_by_name("sql-review", None, &roots) else {
            panic!("a unique name must resolve");
        };
        assert_eq!(skill.source, "default");
        assert_eq!(skill.name, "sql-review");
        assert!(skill.content.contains("Body of sql-review."));
        assert_eq!(skill.dir, roots.default.clone().unwrap().join("alpha"));
        assert!(skill.id.starts_with("d-"));
    }

    #[test]
    fn read_skill_by_name_never_guesses_between_real_skills() {
        let root = temp_skills_root("ambiguous");
        write_named_skill(&root, "one", "shared", "first");
        write_named_skill(&root, "two", "shared", "second");
        let custom = temp_skills_root("ambiguous-custom");
        write_named_skill(&custom, "three", "shared", "third");
        let roots = roots_of(&root, Some(&custom));

        let SkillLookup::Ambiguous(candidates) = read_skill_by_name("shared", None, &roots) else {
            panic!("three skills share the name; the tool must list them, not pick one");
        };
        assert_eq!(candidates.len(), 3);
        assert!(candidates.iter().any(|candidate| candidate.source == "custom"));

        // `source` narrows it, but two entries in the same root stay ambiguous:
        // guessing between them would be a silent wrong answer.
        let SkillLookup::Ambiguous(candidates) = read_skill_by_name("shared", Some("default"), &roots) else {
            panic!("two entries in one root remain ambiguous");
        };
        assert_eq!(candidates.len(), 2);

        let SkillLookup::Found(skill) = read_skill_by_name("shared", Some("custom"), &roots) else {
            panic!("source must disambiguate");
        };
        assert_eq!(skill.source, "custom");
        assert_eq!(skill.description, "third");
    }

    #[test]
    fn read_skill_by_name_matches_exactly_and_refuses_an_empty_name() {
        let root = temp_skills_root("exact-name");
        write_named_skill(&root, "alpha", "sql-review", "rules");
        let roots = roots_of(&root, None);

        assert!(matches!(read_skill_by_name("", None, &roots), SkillLookup::NotFound));
        assert!(matches!(read_skill_by_name("   ", None, &roots), SkillLookup::NotFound));
        // Exact matching is deliberate: the listing prints the name verbatim, so
        // a fuzzy matcher would turn "did you mean" into a silent wrong skill.
        assert!(matches!(read_skill_by_name("SQL-Review", None, &roots), SkillLookup::NotFound));
        assert!(matches!(read_skill_by_name("d-abc", None, &roots), SkillLookup::NotFound));
    }

    #[test]
    fn list_skill_candidates_reports_names_and_sources_only() {
        let root = temp_skills_root("candidates");
        write_named_skill(&root, "alpha", "sql-review", "rules");
        let custom = temp_skills_root("candidates-custom");
        write_named_skill(&custom, "beta", "team-rules", "team");
        let roots = roots_of(&root, Some(&custom));

        let candidates = list_skill_candidates(&roots);
        let listed: Vec<(&str, &str)> =
            candidates.iter().map(|candidate| (candidate.name.as_str(), candidate.source)).collect();
        // Root order is fixed (default first) so the recovery answer is stable.
        assert_eq!(listed, [("sql-review", "default"), ("team-rules", "custom")]);
        for candidate in &candidates {
            assert!(!candidate.description.is_empty());
        }
    }

    #[test]
    fn list_skill_files_uses_relative_paths_and_skips_hidden_and_vendor_dirs() {
        let root = temp_skills_root("listing-files");
        let dir = write_named_skill(&root, "alpha", "alpha", "d");
        std::fs::create_dir_all(dir.join("references").join("deep")).unwrap();
        std::fs::write(dir.join("references").join("one.md"), "one").unwrap();
        std::fs::write(dir.join("references").join("deep").join("two.md"), "two").unwrap();
        std::fs::write(dir.join("script.py"), "print(1)").unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules").join("dep.js"), "x").unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden").join("secret.md"), "x").unwrap();
        let binary = vec![0x89u8, b'P', b'N', b'G', 0, 1, 2, 3];
        std::fs::write(dir.join("logo.png"), &binary).unwrap();

        let canonical = std::fs::canonicalize(&dir).unwrap();
        let listing = list_skill_files(&canonical);
        let paths: Vec<&str> = listing.entries.iter().map(|entry| entry.relative_path.as_str()).collect();
        assert_eq!(paths, vec!["SKILL.md", "logo.png", "references/deep/two.md", "references/one.md", "script.py"]);
        // The model must be able to paste the path straight back into
        // read_skill_file, so separators are normalized regardless of platform.
        assert!(listing.entries.iter().all(|entry| !entry.relative_path.contains('\\')));
        assert!(!listing.truncated);

        let png = listing.entries.iter().find(|entry| entry.relative_path == "logo.png").unwrap();
        assert!(!png.text, "a NUL byte marks the file as binary");
        assert_eq!(png.bytes, binary.len() as u64);
        assert!(listing.entries.iter().find(|entry| entry.relative_path == "script.py").unwrap().text);
    }

    #[test]
    fn list_skill_files_reports_truncation_instead_of_a_partial_list() {
        let root = temp_skills_root("listing-cap");
        let dir = write_named_skill(&root, "many", "many", "d");
        for index in 0..SKILL_LISTING_MAX_ENTRIES + 5 {
            std::fs::write(dir.join(format!("file-{index:03}.md")), "x").unwrap();
        }
        let canonical = std::fs::canonicalize(&dir).unwrap();
        let listing = list_skill_files(&canonical);
        assert_eq!(listing.entries.len(), SKILL_LISTING_MAX_ENTRIES);
        assert!(listing.truncated, "a capped listing must say so rather than look complete");
    }

    #[test]
    fn read_skill_file_relative_reads_inside_the_skill_directory_only() {
        let root = temp_skills_root("read-rel");
        let dir = write_named_skill(&root, "alpha", "alpha", "d");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("references").join("one.md"), "reference body").unwrap();
        std::fs::write(root.join("outside.md"), "outside body").unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();

        assert_eq!(read_skill_file_relative(&canonical, "references/one.md").unwrap(), "reference body");
        assert!(read_skill_file_relative(&canonical, "SKILL.md").unwrap().contains("name: alpha"));

        // Escapes and absolutes are refused outright rather than left to the
        // containment check, so the reason stays stable across platforms.
        // The Windows-shaped absolute path matters: `is_absolute` is false for
        // "/etc/hosts" there, and the containment check is what catches it.
        for escape in [
            "../outside.md",
            "references/../../outside.md",
            "..\\outside.md",
            "/etc/hosts",
            "C:\\Windows\\win.ini",
            "  ",
        ] {
            assert_eq!(
                read_skill_file_relative(&canonical, escape).unwrap_err(),
                REASON_NOT_FOUND,
                "must reject {escape:?}"
            );
        }
        // A directory and a missing name are both not-found, never a read.
        assert_eq!(read_skill_file_relative(&canonical, "references").unwrap_err(), REASON_NOT_FOUND);
        assert_eq!(read_skill_file_relative(&canonical, "nope.md").unwrap_err(), REASON_NOT_FOUND);
    }

    #[test]
    fn read_skill_file_relative_refuses_binary_oversized_and_non_utf8_files() {
        let root = temp_skills_root("read-reject");
        let dir = write_named_skill(&root, "alpha", "alpha", "d");
        let canonical = std::fs::canonicalize(&dir).unwrap();

        std::fs::write(dir.join("with-nul.md"), b"text\0more").unwrap();
        assert_eq!(read_skill_file_relative(&canonical, "with-nul.md").unwrap_err(), REASON_NOT_TEXT);

        // No NUL here, so this must fall through to the encoding check rather
        // than being mistaken for binary.
        std::fs::write(dir.join("broken.md"), [0xFFu8, 0xFE]).unwrap();
        assert_eq!(read_skill_file_relative(&canonical, "broken.md").unwrap_err(), REASON_NOT_UTF8);

        let big = dir.join("big.md");
        std::fs::write(&big, "x").unwrap();
        std::fs::OpenOptions::new().write(true).open(&big).unwrap().set_len(MAX_SKILL_FILE_BYTES + 1).unwrap();
        assert_eq!(read_skill_file_relative(&canonical, "big.md").unwrap_err(), REASON_OVERSIZED);
    }

    #[cfg(unix)]
    #[test]
    fn read_skill_file_relative_cannot_follow_a_link_out_of_the_skill_directory() {
        use std::os::unix::fs::symlink;
        let root = temp_skills_root("rel-link");
        let dir = write_named_skill(&root, "alpha", "alpha", "d");
        let outside = temp_skills_root("rel-link-outside");
        let outside_file = outside.join("secret.md");
        std::fs::write(&outside_file, "secret").unwrap();
        symlink(&outside_file, dir.join("link.md")).unwrap();
        symlink(&outside, dir.join("linkdir")).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();

        assert_eq!(read_skill_file_relative(&canonical, "link.md").unwrap_err(), REASON_NOT_FOUND);
        assert_eq!(read_skill_file_relative(&canonical, "linkdir/secret.md").unwrap_err(), REASON_NOT_FOUND);
        let listing = list_skill_files(&canonical);
        assert!(!listing.entries.iter().any(|entry| entry.relative_path.starts_with("link")));
    }

    // ── Windows reparse-point equivalents ──────────────────────────────────
    //
    // The `#[cfg(unix)]` tests above are COMPILED OUT on Windows rather than
    // skipped at runtime (`0 ignored` in a Windows run proves it), which would
    // leave the containment rule untested on the platform DBX ships — and that
    // rule is what stops `read_skill_file` (model-controlled input) from reading
    // an arbitrary local file. A directory junction is a reparse point that
    // `std::fs::canonicalize` (`GetFinalPathNameByHandleW`) resolves exactly
    // like a symlink, and creating one needs no
    // SeCreateSymbolicLinkPrivilege, so the directory cases run unconditionally
    // here instead of behind a privilege check.
    //
    // Still uncovered on Windows, deliberately: a FILE-level link. `symlink_file`
    // needs Developer Mode or that privilege, and a junction cannot stand in for
    // it, so a test that creates one either fails on every machine without the
    // privilege or passes while asserting nothing. The containment check runs on
    // the canonicalized path and is indifferent to which reparse point produced
    // it, so what the junction tests leave unverified is narrow — that Windows
    // resolves file symlinks exactly as it resolves junctions in `canonicalize`.
    // Hard links stay uncovered on every platform: `canonicalize` does not reveal
    // their target at all.
    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        // `mklink` is a cmd builtin and refuses to overwrite, so callers only
        // pass paths that cannot exist yet. A failing junction creation is a loud
        // failure, never a silent skip: a green test that asserts nothing is
        // worse than a red one.
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd must be runnable to create a junction");
        assert!(
            output.status.success(),
            "junction creation failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn junction_policy_allows_inside_root_only() {
        let root = temp_skills_root("junction-links");
        let real = write_skill(&root, "real", VALID_BODY);
        create_junction(&root.join("inside"), &real);
        let outside = temp_skills_root("junction-outside");
        let escapee = write_skill(&outside, "escapee", VALID_BODY);
        create_junction(&root.join("escape"), &escapee);

        let canonical = std::fs::canonicalize(&root).unwrap();
        let ids: Vec<String> = scan_root(&canonical, "d").into_iter().map(|skill| skill.id).collect();
        assert!(ids.contains(&skill_id("d", "inside")));
        assert!(!ids.contains(&skill_id("d", "escape")), "a junction out of the root must stay invisible");
    }

    #[cfg(windows)]
    #[test]
    fn junction_inside_a_skill_directory_cannot_be_read_or_listed() {
        let root = temp_skills_root("junction-rel");
        let dir = write_named_skill(&root, "alpha", "alpha", "d");
        let outside = temp_skills_root("junction-rel-outside");
        std::fs::write(outside.join("secret.md"), "secret").unwrap();
        create_junction(&dir.join("linkdir"), &outside);

        let canonical = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(read_skill_file_relative(&canonical, "linkdir/secret.md").unwrap_err(), REASON_NOT_FOUND);
        let listing = list_skill_files(&canonical);
        assert!(!listing.entries.iter().any(|entry| entry.relative_path.starts_with("linkdir")));
    }
}
