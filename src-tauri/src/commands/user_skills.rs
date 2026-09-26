//! Read-only discovery and reading of user-level SKILL.md skills.
//!
//! Two roots are scanned: the default user-level root (HOME/.agents/skills) and
//! an optional user-configured custom root (Settings > AI). The service is
//! strictly read-only: there is no create/write/delete API. Skills are
//! identified by deterministic opaque ids derived from the root source and the
//! canonical relative skill directory name, so ids survive Refresh (prd.md:34).
//! Absolute paths never leave this module (prd.md:33).

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
#[tauri::command]
pub async fn list_user_skills(
    custom_root_enabled: bool,
    custom_root: Option<String>,
) -> Result<UserSkillsListResult, String> {
    tauri::async_runtime::spawn_blocking(move || list_user_skills_blocking(custom_root_enabled, custom_root.as_deref()))
        .await
        .map_err(|error| error.to_string())
}

/// Reads the currently selected skills by id. Every id is resolved only
/// through re-derivation over a fresh scan of the owning root, so a deleted,
/// moved, or root-escaping skill fails instead of silently resolving to a
/// stale path (prd.md:37).
#[tauri::command]
pub async fn read_user_skills(
    ids: Vec<String>,
    custom_root_enabled: bool,
    custom_root: Option<String>,
) -> Result<UserSkillsReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_user_skills_blocking(&ids, custom_root_enabled, custom_root.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
}

fn list_user_skills_blocking(custom_root_enabled: bool, custom_root: Option<&str>) -> UserSkillsListResult {
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

fn read_user_skills_blocking(
    ids: &[String],
    custom_root_enabled: bool,
    custom_root: Option<&str>,
) -> UserSkillsReadResult {
    let default_root =
        default_skills_root().and_then(|path| std::fs::canonicalize(&path).ok()).filter(|path| path.is_dir());
    let custom_root = if custom_root_enabled { enabled_custom_root(custom_root) } else { None };
    read_user_skills_from(ids, default_root.as_deref(), custom_root.as_deref())
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
fn scan_root(canonical_root: &Path, prefix: &str) -> Vec<UserSkillMeta> {
    let mut skills = Vec::new();
    let Ok(entries) = std::fs::read_dir(canonical_root) else { return skills };
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
        let Some((name, description)) = discover_skill_metadata(&canonical_skill_file) else { continue };
        skills.push(UserSkillMeta { id: skill_id(prefix, &dir_name), name, description });
    }
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
    let entries = std::fs::read_dir(canonical_root).map_err(|_| REASON_NOT_FOUND.to_string())?;
    for entry in entries.flatten() {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if dir_name.starts_with('.') || skill_id(prefix, &dir_name) != id {
            continue;
        }
        let canonical_dir = entry.path().canonicalize().map_err(|_| REASON_NOT_FOUND.to_string())?;
        if !canonical_dir.starts_with(canonical_root) || !canonical_dir.is_dir() {
            return Err(REASON_NOT_FOUND.to_string());
        }
        let skill_file = canonical_dir.join(SKILL_FILE_NAME);
        let canonical_skill_file = skill_file.canonicalize().map_err(|_| REASON_NOT_FOUND.to_string())?;
        // Re-check the entry file on every send, not just its parent directory:
        // another process may have swapped SKILL.md for an escaping symlink
        // after it was discovered.
        if !canonical_skill_file.starts_with(canonical_root) {
            return Err(REASON_NOT_FOUND.to_string());
        }
        return read_skill_file(&canonical_skill_file, id);
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
        let disabled =
            read_user_skills_blocking(std::slice::from_ref(&custom_id), false, Some(custom.to_str().unwrap()));
        assert_eq!(disabled.failures.len(), 1);
        assert_eq!(disabled.failures[0].reason, "root_unavailable");
        let vanished = read_user_skills_blocking(&[custom_id], true, Some(custom.join("nope").to_str().unwrap()));
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
}
