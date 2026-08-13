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
        validate_entry_name(&new_name)?;
        if !source.exists() {
            return Err("The file or folder no longer exists".to_string());
        }
        let parent = source.parent().ok_or_else(|| "Invalid path".to_string())?;
        let target = parent.join(&new_name);
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
}
