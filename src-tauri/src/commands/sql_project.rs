use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use dbx_core::connection::AppState;
use dbx_core::sql::{decode_sql_file_bytes_with_meta, SqlFileEncoding, SqlFileLineEnding};
use dbx_core::sql_project::{SqlFileSnapshot, SqlProject};
use serde::Serialize;
use tauri::State;

use super::external_sql::is_sql_file_path;

const MAX_SNAPSHOT_FILE_BYTES: u64 = 8 * 1024 * 1024;

// ---------- OS 级打开项目入口（拖文件夹到图标/命令行参数） ----------

#[derive(Default)]
pub struct PendingOpenSqlProjects {
    pending: Mutex<Vec<String>>,
}

impl PendingOpenSqlProjects {
    pub fn push(&self, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.extend(paths);
        }
    }

    fn drain(&self) -> Vec<String> {
        self.pending.lock().map(|mut pending| pending.drain(..).collect()).unwrap_or_default()
    }
}

/// 命令行参数中"是目录"的路径视为待打开项目；.sql 文件仍走 external_sql 链路。
pub fn project_dir_paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter(|arg| !arg.as_ref().starts_with('-'))
        .map(|arg| {
            let path = PathBuf::from(arg.as_ref());
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
pub fn pending_open_sql_projects(state: State<'_, PendingOpenSqlProjects>) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut paths = project_dir_paths_from_args(std::env::args().skip(1), &cwd);
    paths.extend(state.drain());
    let mut unique = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
}

// ---------- 项目 CRUD ----------

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[tauri::command]
pub async fn list_sql_projects(state: State<'_, std::sync::Arc<AppState>>) -> Result<Vec<SqlProject>, String> {
    state.storage.list_sql_projects().await
}

/// 按路径打开项目：canonicalize 归一后，已存在则 touch，不存在则创建（trusted=false）。
#[tauri::command]
pub async fn open_sql_project_by_path(
    state: State<'_, std::sync::Arc<AppState>>,
    root_path: String,
) -> Result<SqlProject, String> {
    let canonical = tokio::task::spawn_blocking(move || {
        std::fs::canonicalize(&root_path).map_err(|e| format!("Failed to resolve project directory: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    if !canonical.is_dir() {
        return Err("Project directory does not exist".to_string());
    }
    let canonical_str = canonical.to_string_lossy().to_string();

    if let Some(existing) = state.storage.find_sql_project_by_root_path(&canonical_str).await? {
        let now = now_iso();
        state.storage.touch_sql_project(&existing.id, &now).await?;
        let mut updated = existing;
        updated.last_opened_at = now;
        return Ok(updated);
    }

    let name = canonical.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| canonical_str.clone());
    let project = SqlProject {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        root_path: canonical_str,
        connection_id: None,
        default_schema: None,
        trusted: false,
        created_at: now_iso(),
        last_opened_at: now_iso(),
    };
    state.storage.save_sql_project(&project).await?;
    Ok(project)
}

#[tauri::command]
pub async fn save_sql_project(
    state: State<'_, std::sync::Arc<AppState>>,
    project: SqlProject,
) -> Result<SqlProject, String> {
    state.storage.save_sql_project(&project).await?;
    Ok(project)
}

#[tauri::command]
pub async fn delete_sql_project(state: State<'_, std::sync::Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_sql_project(&id).await
}

// ---------- 保存前快照（Local History 保底） ----------

/// 保存文件前调用：读取磁盘当前内容写入快照；文件不存在（新建）则跳过。
#[tauri::command]
pub async fn snapshot_sql_file_before_save(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    path: String,
) -> Result<(), String> {
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Failed to read SQL file before saving: {error}")),
    };
    if bytes.len() as u64 > MAX_SNAPSHOT_FILE_BYTES {
        return Ok(());
    }
    let decoded = match decode_sql_file_bytes_with_meta(&bytes) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(()),
    };
    let snapshot = SqlFileSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        path,
        content: decoded.content,
        encoding: encoding_label(decoded.encoding),
        saved_at: now_iso(),
    };
    state.storage.insert_sql_file_snapshot(&snapshot).await
}

fn encoding_label(encoding: SqlFileEncoding) -> String {
    // 必须与 SqlFileEncoding 的 serde(rename_all = "kebab-case") 序列化值一致，
    // 否则前端把快照 encoding 原样回传 write_external_sql_file 时反序列化会失败。
    match encoding {
        SqlFileEncoding::Utf8 => "utf8",
        SqlFileEncoding::Utf8Bom => "utf8-bom",
        SqlFileEncoding::Utf16Le => "utf16-le",
        SqlFileEncoding::Utf16Be => "utf16-be",
        SqlFileEncoding::Gbk => "gbk",
    }
    .to_string()
}

#[allow(dead_code)]
fn line_ending_label(line_ending: SqlFileLineEnding) -> &'static str {
    match line_ending {
        SqlFileLineEnding::Lf => "lf",
        SqlFileLineEnding::Crlf => "crlf",
    }
}

/// 查询某文件的本地历史快照列表（按保存时间倒序，供 Local History UI 使用）。
#[tauri::command]
pub async fn list_sql_file_snapshots(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    path: String,
    limit: usize,
) -> Result<Vec<SqlFileSnapshot>, String> {
    state.storage.list_sql_file_snapshots(&project_id, &path, limit).await
}

// ---------- 项目内文件操作 ----------

/// Windows 非法文件名字符与保留名校验（前端先校验，此处兜底）。
fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.trim().is_empty() {
        return Err("File name must not be empty".to_string());
    }
    if name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("File name contains invalid characters: {name}"));
    }
    if name.starts_with(' ') || name.ends_with(' ') || name.starts_with('.') || name.ends_with('.') {
        return Err(format!("File name must not start or end with a space or dot: {name}"));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
        "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("File name is reserved by Windows: {name}"));
    }
    Ok(())
}

/// 把相对路径安全地解析到项目根目录之内（防路径穿越）。
fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim();
    if relative.is_empty() {
        return Err("Relative path must not be empty".to_string());
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err("Relative path must not be absolute".to_string());
    }
    for component in relative_path.components() {
        match component {
            Component::ParentDir => return Err("Relative path must not contain '..'".to_string()),
            Component::Prefix(_) | Component::RootDir => {
                return Err("Relative path must not contain a root".to_string())
            }
            Component::Normal(_) | Component::CurDir => {}
        }
    }
    let joined = root.join(relative_path);
    // 词法归一后再确认仍位于根目录之内。
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(root) {
        return Err("Path escapes the project root".to_string());
    }
    Ok(normalized)
}

fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root_path);
    std::fs::canonicalize(&root).map_err(|e| format!("Failed to resolve project root: {e}"))
}

/// 对 resolve_within_root 的结果做真实路径校验：
/// 1. canonicalize 目标路径（若目标不存在，canonicalize 最近存在的父目录）
/// 2. 确认 canonicalize 后的路径仍在 canonicalize 后的 root 内
/// 防止 symlink 越界：root/evil → /external，词法上 evil/x.sql 在 root 内但实际指向外部。
fn canonicalize_within_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Failed to canonicalize project root: {e}"))?;

    let canonical_target = if target.exists() {
        std::fs::canonicalize(target)
            .map_err(|e| format!("Failed to canonicalize target: {e}"))?
    } else {
        // 目标可能尚不存在（create 场景），回溯到最近存在的父目录
        let mut existing = target.to_path_buf();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            if let Some(name) = existing.file_name() {
                tail.push(name.to_os_string());
                existing = existing
                    .parent()
                    .ok_or_else(|| "Invalid path".to_string())?
                    .to_path_buf();
            } else {
                return Err("Cannot resolve target path".to_string());
            }
        }
        let mut canonical = std::fs::canonicalize(&existing)
            .map_err(|e| format!("Failed to canonicalize parent: {e}"))?;
        for name in tail.into_iter().rev() {
            canonical.push(name);
        }
        canonical
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err("Path escapes the project root (symlink traversal detected)".to_string());
    }
    Ok(canonical_target)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntryOpResult {
    pub path: String,
}

#[tauri::command]
pub async fn create_project_file(
    root_path: String,
    relative_path: String,
    content: String,
) -> Result<ProjectEntryOpResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_within_root(&root, &relative_path)?;
        let target = canonicalize_within_root(&root, &target)?;
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        validate_entry_name(&name)?;
        if !is_sql_file_path(&target) {
            return Err("Only .sql files can be created here".to_string());
        }
        if target.exists() {
            return Err(format!("File already exists: {name}"));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
        std::fs::write(&target, content).map_err(|e| format!("Failed to create file: {e}"))?;
        Ok(ProjectEntryOpResult { path: target.to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_project_folder(root_path: String, relative_path: String) -> Result<ProjectEntryOpResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_within_root(&root, &relative_path)?;
        let target = canonicalize_within_root(&root, &target)?;
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        validate_entry_name(&name)?;
        if target.exists() {
            return Err(format!("Folder already exists: {name}"));
        }
        std::fs::create_dir_all(&target).map_err(|e| format!("Failed to create folder: {e}"))?;
        Ok(ProjectEntryOpResult { path: target.to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_project_entry(
    root_path: String,
    relative_path: String,
    new_name: String,
) -> Result<ProjectEntryOpResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_within_root(&root, &relative_path)?;
        let source = canonicalize_within_root(&root, &source)?;
        validate_entry_name(&new_name)?;
        if !source.exists() {
            return Err("The file or folder no longer exists".to_string());
        }
        let parent = source.parent().ok_or_else(|| "Invalid path".to_string())?;
        let target = parent.join(&new_name);
        let target = canonicalize_within_root(&root, &target)?;
        if source == target {
            return Ok(ProjectEntryOpResult { path: source.to_string_lossy().to_string() });
        }
        if target.exists() {
            return Err(format!("A file or folder already exists: {new_name}"));
        }
        std::fs::rename(&source, &target).map_err(|e| format!("Failed to rename: {e}"))?;
        Ok(ProjectEntryOpResult { path: target.to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn count_files_recursive(path: &Path, depth: usize) -> u64 {
    if depth > 10 {
        return 0;
    }
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_file() {
            count += 1;
        } else if entry_path.is_dir() {
            count += count_files_recursive(&entry_path, depth + 1);
        }
    }
    count
}

/// 目录内文件数量（删除确认对话框展示影响范围用）。
#[tauri::command]
pub async fn count_project_entry_files(root_path: String, relative_path: String) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_within_root(&root, &relative_path)?;
        let target = canonicalize_within_root(&root, &target)?;
        if target.is_file() {
            return Ok(1);
        }
        Ok(count_files_recursive(&target, 0))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除文件/文件夹到回收站（可恢复）。
#[tauri::command]
pub async fn delete_project_entry_to_trash(root_path: String, relative_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_within_root(&root, &relative_path)?;
        let target = canonicalize_within_root(&root, &target)?;
        if !target.exists() {
            return Err("The file or folder no longer exists".to_string());
        }
        if target == root {
            return Err("Cannot delete the project root itself".to_string());
        }
        trash::delete(&target).map_err(|e| format!("Failed to move to trash: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_entry_names() {
        assert!(validate_entry_name("proc_1.sql").is_ok());
        assert!(validate_entry_name("中文 存储过程.sql").is_ok());
        assert!(validate_entry_name("").is_err());
        assert!(validate_entry_name("a/b.sql").is_err());
        assert!(validate_entry_name("a:b").is_err());
        assert!(validate_entry_name(" leading").is_err());
        assert!(validate_entry_name("trailing. ").is_err());
        assert!(validate_entry_name(".hidden").is_err());
        assert!(validate_entry_name("CON.sql").is_err());
        assert!(validate_entry_name("nul").is_err());
        assert!(validate_entry_name("COM3").is_err());
    }

    #[test]
    fn resolves_relative_paths_within_root() {
        let root = Path::new(if cfg!(windows) { r"C:\projects\sp" } else { "/projects/sp" });
        assert_eq!(resolve_within_root(root, "2024/proc.sql").unwrap(), root.join("2024").join("proc.sql"));
        assert!(resolve_within_root(root, "../escape.sql").is_err());
        assert!(resolve_within_root(root, "a/../../escape.sql").is_err());
        assert!(resolve_within_root(root, "").is_err());
        let absolute = if cfg!(windows) { r"C:\other\x.sql" } else { "/other/x.sql" };
        assert!(resolve_within_root(root, absolute).is_err());
    }

    #[test]
    fn filters_directory_args_from_cli_args() {
        let temp = std::env::temp_dir();
        let dir = temp.join(format!("dbx-project-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = temp.join(format!("dbx-arg-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&file_path, "select 1;").unwrap();

        let dirs = project_dir_paths_from_args(
            [dir.to_string_lossy().to_string(), file_path.to_string_lossy().to_string(), "--flag".to_string()],
            &temp,
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&file_path);
        assert_eq!(dirs, vec![dir.to_string_lossy().to_string()]);
    }

    // ---- symlink 越界回归测试 ----

    /// 辅助：创建临时项目根目录和外部目录，返回 (root, outside)
    fn setup_symlink_test_dirs() -> (std::path::PathBuf, std::path::PathBuf) {
        let temp = std::env::temp_dir();
        let root = temp.join(format!("dbx-symlink-root-{}", uuid::Uuid::new_v4()));
        let outside = temp.join(format!("dbx-symlink-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        (root, outside)
    }

    /// 辅助：清理临时目录
    fn cleanup_dirs(dirs: &[&std::path::Path]) {
        for dir in dirs {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// symlink 指向外部目录时，resolve_within_root 词法通过但 canonicalize_within_root 应拒绝。
    #[test]
    fn rejects_symlink_traversal_on_create() {
        let (root, outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        // root/evil → outside
        #[cfg(unix)]
        std::os::unix::symlink(&outside, root.join("evil")).unwrap();
        #[cfg(windows)]
        {
            // Windows 上创建目录 symlink 需要开发者模式或管理员权限，跳过而非失败
            if std::os::windows::fs::symlink_dir(&outside, root.join("evil")).is_err() {
                eprintln!("Skipping symlink test: cannot create symlink on Windows without privileges");
                cleanup_dirs(&[&root, &outside]);
                return;
            }
        }

        // 词法校验通过（evil/test.sql 在 root 内）
        let resolved = resolve_within_root(&root_canonical, "evil/test.sql").unwrap();
        // 真实路径校验应拒绝（evil 是指向外部的 symlink）
        assert!(canonicalize_within_root(&root_canonical, &resolved).is_err());

        cleanup_dirs(&[&root, &outside]);
    }

    /// symlink 指向外部目录时，已存在的文件通过 symlink 访问应被拒绝。
    #[test]
    fn rejects_symlink_traversal_on_existing_file() {
        let (root, outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        // 在 outside 中创建一个文件
        std::fs::write(outside.join("secret.sql"), "SELECT 1;").unwrap();

        // root/evil → outside
        #[cfg(unix)]
        std::os::unix::symlink(&outside, root.join("evil")).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&outside, root.join("evil")).is_err() {
                eprintln!("Skipping symlink test: cannot create symlink on Windows without privileges");
                cleanup_dirs(&[&root, &outside]);
                return;
            }
        }

        // evil/secret.sql 通过 symlink 实际指向 outside/secret.sql
        let resolved = resolve_within_root(&root_canonical, "evil/secret.sql").unwrap();
        let result = canonicalize_within_root(&root_canonical, &resolved);
        assert!(result.is_err(), "Should reject access to file via symlink outside root");

        cleanup_dirs(&[&root, &outside]);
    }

    /// rename 时 source 本身是 symlink，目标路径也应校验。
    #[test]
    fn rejects_symlink_traversal_on_rename() {
        let (root, outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        #[cfg(unix)]
        std::os::unix::symlink(&outside, root.join("evil")).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&outside, root.join("evil")).is_err() {
                eprintln!("Skipping symlink test: cannot create symlink on Windows without privileges");
                cleanup_dirs(&[&root, &outside]);
                return;
            }
        }

        // 尝试 rename evil → evil_renamed
        // resolve_within_root 对 "evil" 词法通过
        let source = resolve_within_root(&root_canonical, "evil").unwrap();
        // canonicalize_within_root 应检测到 evil 是指向外部的 symlink
        assert!(canonicalize_within_root(&root_canonical, &source).is_err());

        // 即使 source 通过了，rename 的目标 evil_renamed 的父目录是 root（安全），
        // 但 source 已被拒绝，rename 不应继续
        cleanup_dirs(&[&root, &outside]);
    }

    /// delete 到回收站时，symlink 越界应被拒绝。
    #[test]
    fn rejects_symlink_traversal_on_delete() {
        let (root, outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        // 在 outside 中创建文件
        std::fs::write(outside.join("victim.sql"), "SELECT 1;").unwrap();

        #[cfg(unix)]
        std::os::unix::symlink(&outside, root.join("evil")).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&outside, root.join("evil")).is_err() {
                eprintln!("Skipping symlink test: cannot create symlink on Windows without privileges");
                cleanup_dirs(&[&root, &outside]);
                return;
            }
        }

        // evil/victim.sql 通过 symlink 指向 outside/victim.sql
        let resolved = resolve_within_root(&root_canonical, "evil/victim.sql").unwrap();
        assert!(canonicalize_within_root(&root_canonical, &resolved).is_err());

        // 确认 outside/victim.sql 仍然存在（未被删除）
        assert!(outside.join("victim.sql").exists());

        cleanup_dirs(&[&root, &outside]);
    }

    /// 正常路径（非 symlink）应通过 canonicalize_within_root。
    #[test]
    fn accepts_normal_path_within_root() {
        let (root, _outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        // 创建子目录和文件
        std::fs::create_dir_all(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir").join("normal.sql"), "SELECT 1;").unwrap();

        let resolved = resolve_within_root(&root_canonical, "subdir/normal.sql").unwrap();
        assert!(canonicalize_within_root(&root_canonical, &resolved).is_ok());

        cleanup_dirs(&[&root]);
    }

    /// 目标文件尚不存在（create 场景），canonicalize 父目录后应通过。
    #[test]
    fn accepts_nonexistent_target_with_existing_parent() {
        let (root, _outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        // subdir 存在但 new_file.sql 不存在
        std::fs::create_dir_all(root.join("subdir")).unwrap();
        let resolved = resolve_within_root(&root_canonical, "subdir/new_file.sql").unwrap();
        assert!(canonicalize_within_root(&root_canonical, &resolved).is_ok());

        cleanup_dirs(&[&root]);
    }

    /// 嵌套 symlink：root/a/b → symlink → outside，深层路径也应被拒绝。
    #[test]
    fn rejects_nested_symlink_traversal() {
        let (root, outside) = setup_symlink_test_dirs();
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        // root/a/b → outside
        std::fs::create_dir_all(root.join("a")).unwrap();
        #[cfg(unix)]
        std::os::unix::symlink(&outside, root.join("a").join("b")).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&outside, root.join("a").join("b")).is_err() {
                eprintln!("Skipping symlink test: cannot create symlink on Windows without privileges");
                cleanup_dirs(&[&root, &outside]);
                return;
            }
        }

        // a/b/deep.sql 词法上在 root 内，实际指向 outside/deep.sql
        let resolved = resolve_within_root(&root_canonical, "a/b/deep.sql").unwrap();
        assert!(canonicalize_within_root(&root_canonical, &resolved).is_err());

        cleanup_dirs(&[&root, &outside]);
    }
}
