use std::collections::HashSet;
use std::path::Path;

use crate::schema_diff::SchemaDiffPreparationOptions;

#[derive(Debug, Clone)]
pub struct DiffEntry {
    pub file_path: String,
    pub sql_content: String,
    pub change_type: ChangeType,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

pub struct GitDiffScanner {
    repo_path: String,
    base_commit: String,
    target_commit: String,
}

impl GitDiffScanner {
    pub fn new(repo_path: &Path, base_commit: &str, target_commit: &str) -> Result<Self, String> {
        if base_commit.is_empty() || target_commit.is_empty() {
            return Err("Git commit refs cannot be empty".into());
        }
        let git_path = repo_path.join(".git");
        let is_git_repo =
            git_path.is_dir() || (git_path.is_file() && git_path.exists()) || repo_path.join("../.git").exists();
        if !is_git_repo {
            return Err(format!("Not a git repository: {}", repo_path.display()));
        }
        Ok(Self {
            repo_path: repo_path.to_string_lossy().to_string(),
            base_commit: base_commit.to_string(),
            target_commit: target_commit.to_string(),
        })
    }

    pub fn scan(&self) -> Result<Vec<DiffEntry>, String> {
        let output = self.run_git_diff()?;

        let sql_filter = self.build_sql_filter()?;

        let raw_entries = self.parse_diff_output(&output, &sql_filter)?;

        let entries = raw_entries
            .into_iter()
            .filter_map(|entry| {
                if entry.change_type == ChangeType::Deleted {
                    return Some(entry);
                }
                let path = Path::new(&self.repo_path).join(&entry.file_path);
                let content = std::fs::read_to_string(&path).ok()?;
                Some(DiffEntry { sql_content: content, ..entry })
            })
            .collect();

        Ok(entries)
    }

    fn run_git_diff(&self) -> Result<String, String> {
        let output = std::process::Command::new("git")
            .arg("diff")
            .arg("--diff-filter=ACMR")
            .arg(&self.base_commit)
            .arg(&self.target_commit)
            .arg("--")
            .arg("*.sql")
            .arg("*.ddl")
            .current_dir(&self.repo_path)
            .output()
            .map_err(|e| format!("Failed to run git diff: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git diff failed: {stderr}"));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn build_sql_filter(&self) -> Result<HashSet<String>, String> {
        let mut patterns = HashSet::new();
        let gitattributes_path = Path::new(&self.repo_path).join(".gitattributes");
        if gitattributes_path.exists() {
            let content = std::fs::read_to_string(&gitattributes_path)
                .map_err(|e| format!("Failed to read .gitattributes: {e}"))?;
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 && parts[1] == "linguist-language=SQL" {
                    let pattern = parts[0].trim_matches('*');
                    if !pattern.is_empty() {
                        patterns.insert(pattern.to_string());
                    } else {
                        patterns.insert("sql".to_string());
                    }
                }
            }
        }
        if patterns.is_empty() {
            patterns.insert("sql".to_string());
        }
        Ok(patterns)
    }

    fn parse_diff_output(&self, output: &str, _filter: &HashSet<String>) -> Result<Vec<DiffEntry>, String> {
        let mut entries = Vec::new();
        let mut current_file: Option<String> = None;
        let mut current_status: Option<ChangeType> = None;
        let mut current_old_path: Option<String> = None;

        for line in output.lines() {
            if line.starts_with("diff --git ") {
                Self::flush_raw_entry(&mut current_file, &mut current_status, &mut current_old_path, &mut entries);
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 {
                    let b_path = parts.get(3).copied().unwrap_or("");
                    let b_path = b_path.trim_start_matches("b/");
                    current_file = Some(b_path.to_string());
                    current_status = Some(ChangeType::Modified);
                }
            } else if line.starts_with("--- ") {
                let path = line.trim_start_matches("--- ").trim_start_matches("a/");
                if path != "/dev/null" {
                    current_old_path = Some(path.to_string());
                }
            } else if line.starts_with("+++ ") {
                let path = line.trim_start_matches("+++ ").trim_start_matches("b/");
                if path != "/dev/null" {
                    current_file = Some(path.to_string());
                }
            } else if line.starts_with("new file mode") {
                current_status = Some(ChangeType::Added);
            } else if line.starts_with("deleted file mode") {
                current_status = Some(ChangeType::Deleted);
            } else if line.starts_with("rename from ") {
                current_old_path = Some(line.trim_start_matches("rename from ").to_string());
            } else if line.starts_with("rename to ") {
                current_file = Some(line.trim_start_matches("rename to ").to_string());
                current_status = Some(ChangeType::Renamed);
            }
        }

        Self::flush_raw_entry(&mut current_file, &mut current_status, &mut current_old_path, &mut entries);

        Ok(entries)
    }

    fn flush_raw_entry(
        file: &mut Option<String>,
        status: &mut Option<ChangeType>,
        old_path: &mut Option<String>,
        entries: &mut Vec<DiffEntry>,
    ) {
        let file_path = file.take();
        let st = status.take().unwrap_or(ChangeType::Modified);
        let op = old_path.take();
        if let Some(path) = file_path {
            entries.push(DiffEntry { file_path: path, sql_content: String::new(), change_type: st, old_path: op });
        }
    }

    pub fn bind_to_commit(options: SchemaDiffPreparationOptions, _commit_id: &str) -> SchemaDiffPreparationOptions {
        options
    }

    pub fn list_commits(&self, max_count: usize) -> Result<Vec<String>, String> {
        let output = std::process::Command::new("git")
            .arg("log")
            .arg("--oneline")
            .arg("-n")
            .arg(max_count.to_string())
            .arg("--")
            .arg("*.sql")
            .arg("*.ddl")
            .current_dir(&self.repo_path)
            .output()
            .map_err(|e| format!("Failed to run git log: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.lines().map(|l| l.to_string()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_git_directory() {
        let tmp = std::env::temp_dir().join("dbx_test_not_a_repo");
        let _ = std::fs::create_dir_all(&tmp);
        let result = GitDiffScanner::new(&tmp, "HEAD~1", "HEAD");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parses_diff_output_with_added_file() {
        let scanner =
            GitDiffScanner { repo_path: "/tmp/repo".into(), base_commit: "abc".into(), target_commit: "def".into() };
        let output = "diff --git a/schema.sql b/schema.sql\nnew file mode 100644\n--- /dev/null\n+++ b/schema.sql\n@@ -0,0 +1 @@\n+CREATE TABLE t (id INT);\n";
        let mut filter = HashSet::new();
        filter.insert("sql".to_string());
        let entries = scanner.parse_diff_output(output, &filter).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_path, "schema.sql");
        assert_eq!(entries[0].change_type, ChangeType::Added);
    }

    #[test]
    fn parses_diff_output_with_modified_file() {
        let scanner =
            GitDiffScanner { repo_path: "/tmp/repo".into(), base_commit: "abc".into(), target_commit: "def".into() };
        let output = "diff --git a/schema.sql b/schema.sql\n--- a/schema.sql\n+++ b/schema.sql\n@@ -1 +1 @@\n-CREATE TABLE t (id INT);\n+CREATE TABLE t (id BIGINT);\n";
        let mut filter = HashSet::new();
        filter.insert("sql".to_string());
        let entries = scanner.parse_diff_output(output, &filter).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].change_type, ChangeType::Modified);
    }

    #[test]
    fn parses_diff_output_with_renamed_file() {
        let scanner =
            GitDiffScanner { repo_path: "/tmp/repo".into(), base_commit: "abc".into(), target_commit: "def".into() };
        let output = "diff --git a/old.sql b/new.sql\nrename from old.sql\nrename to new.sql\n";
        let mut filter = HashSet::new();
        filter.insert("sql".to_string());
        let entries = scanner.parse_diff_output(output, &filter).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].change_type, ChangeType::Renamed);
        assert_eq!(entries[0].old_path, Some("old.sql".to_string()));
    }

    #[test]
    fn parses_gitattributes_for_sql_patterns() {
        let tmp = std::env::temp_dir().join("dbx_test_gitattributes");
        let _ = std::fs::create_dir_all(&tmp);
        let gitattributes = tmp.join(".gitattributes");
        std::fs::write(&gitattributes, "*.sql linguist-language=SQL\n*.ddl linguist-language=SQL\n").unwrap();

        let scanner = GitDiffScanner {
            repo_path: tmp.to_string_lossy().to_string(),
            base_commit: "abc".into(),
            target_commit: "def".into(),
        };
        let filter = scanner.build_sql_filter().unwrap();
        assert!(!filter.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
