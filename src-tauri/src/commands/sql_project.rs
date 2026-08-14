use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[cfg(test)]
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
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
    state.storage.insert_sql_project(&project).await?;
    Ok(project)
}

/// 更新项目可变元数据（名称/绑定连接/默认 schema）。
/// 刻意不接受 root_path/trusted/created_at，防止前端伪造任意可信项目绕过信任校验。
#[tauri::command]
pub async fn update_sql_project(
    state: State<'_, std::sync::Arc<AppState>>,
    id: String,
    name: String,
    connection_id: Option<String>,
    default_schema: Option<String>,
) -> Result<SqlProject, String> {
    state.storage.update_sql_project(&id, &name, connection_id.as_deref(), default_schema.as_deref()).await?;
    state.storage.find_sql_project_by_id(&id).await?.ok_or_else(|| "Project not found".to_string())
}

/// 后端信任流程：仅将项目标记为 trusted（root_path 已在 open 时 canonicalize 存储，
/// 此处不接受前端传入的路径），返回更新后的完整记录。
#[tauri::command]
pub async fn trust_sql_project(state: State<'_, std::sync::Arc<AppState>>, id: String) -> Result<SqlProject, String> {
    state.storage.trust_sql_project(&id).await?;
    state.storage.find_sql_project_by_id(&id).await?.ok_or_else(|| "Project not found".to_string())
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
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    let snapshot_path = path.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        // `path` 为前端基于 canonical 根目录拼出的绝对路径；剥离根前缀得到相对路径后，
        // 通过已打开的根目录句柄 descriptor-relative 读取，symlink 逃逸会被内核层拒绝。
        let abs = PathBuf::from(&path);
        let rel = abs.strip_prefix(&root.canonical).map_err(|_| "Path is outside the project root".to_string())?;
        let rel = validate_relative_path(&rel.to_string_lossy())?;

        let bytes = match root.dir.read(&rel) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Failed to read SQL file before saving: {error}")),
        };
        if bytes.len() as u64 > MAX_SNAPSHOT_FILE_BYTES {
            return Ok(None);
        }
        let decoded = match decode_sql_file_bytes_with_meta(&bytes) {
            Ok(decoded) => decoded,
            Err(_) => return Ok(None),
        };
        Ok(Some(SqlFileSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            path: snapshot_path,
            content: decoded.content,
            encoding: encoding_label(decoded.encoding),
            saved_at: now_iso(),
        }))
    })
    .await
    .map_err(|e| e.to_string())??;

    match snapshot {
        Some(snapshot) => state.storage.insert_sql_file_snapshot(&snapshot).await,
        None => Ok(()),
    }
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

/// 校验并归一化前端传入的相对路径（防路径穿越：拒绝绝对路径、`..` 与根组件）。
fn validate_relative_path(relative: &str) -> Result<PathBuf, String> {
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
    let mut normalized = PathBuf::new();
    for component in relative_path.components() {
        match component {
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Relative path must not be empty".to_string());
    }
    Ok(normalized)
}

/// 词法解析到项目根目录之内（仅供测试用）。
#[cfg(test)]
fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    Ok(root.join(validate_relative_path(relative)?))
}

/// 按字节上限截断字符串，且保证落在 UTF-8 字符边界内。
/// 用于限制 staged 回收站名长度，避免超长多字节文件名导致超过 NAME_MAX。
fn truncate_to_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root_path);
    std::fs::canonicalize(&root).map_err(|e| format!("Failed to resolve project root: {e}"))
}

/// 已打开的项目根目录句柄：所有项目内文件操作都基于该句柄以 descriptor-relative
/// 方式执行。cap-std 会在解析路径时保证 symlink 不逃逸出根目录（Linux 上为
/// openat2 RESOLVE_BENEATH，其余平台逐组件校验），从而关闭 "先 canonicalize
/// 校验、再按字符串路径操作" 的 TOCTOU 窗口。
struct ProjectRoot {
    canonical: PathBuf,
    dir: Dir,
}

impl ProjectRoot {
    fn open(canonical: &Path) -> Result<Self, String> {
        let dir = Dir::open_ambient_dir(canonical, ambient_authority())
            .map_err(|e| format!("Failed to open project root: {e}"))?;
        Ok(Self { canonical: canonical.to_path_buf(), dir })
    }
}

/// 根据 project_id 查询已保存的项目记录，返回 (已打开根目录句柄, project)。
/// 若项目不存在或未信任则返回 Err。
async fn resolve_trusted_root(
    state: &std::sync::Arc<AppState>,
    project_id: &str,
) -> Result<(ProjectRoot, SqlProject), String> {
    let project =
        state.storage.find_sql_project_by_id(project_id).await?.ok_or_else(|| "Project not found".to_string())?;
    if !project.trusted {
        return Err("Project is not trusted".to_string());
    }
    let canonical = canonical_root(&project.root_path)?;
    let root = ProjectRoot::open(&canonical)?;
    Ok((root, project))
}

/// 逐组件以 no-follow 方式打开相对路径对应的目录，返回该目录句柄。
/// 仅测试用：用于验证 cap-std 的 `open_dir_nofollow` 对中间 symlink 组件的拒绝行为。
#[cfg(test)]
fn open_dir_nofollow_components(root: &Dir, rel: &Path) -> Result<Dir, String> {
    let mut current = root.try_clone().map_err(|e| format!("Failed to clone root handle: {e}"))?;
    for component in rel.components() {
        match component {
            Component::Normal(name) => {
                current = current
                    .open_dir_nofollow(Path::new(name))
                    .map_err(|e| format!("Failed to open directory component without following symlinks: {e}"))?;
            }
            Component::CurDir => {}
            _ => return Err("Invalid path component".to_string()),
        }
    }
    Ok(current)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntryOpResult {
    pub path: String,
}

#[tauri::command]
pub async fn create_project_file(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    relative_path: String,
    content: String,
) -> Result<ProjectEntryOpResult, String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    tokio::task::spawn_blocking(move || {
        let rel = validate_relative_path(&relative_path)?;
        let name = rel.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        validate_entry_name(&name)?;
        if !is_sql_file_path(&rel) {
            return Err("Only .sql files can be created here".to_string());
        }
        if let Some(parent) = rel.parent() {
            if !parent.as_os_str().is_empty() {
                root.dir.create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
            }
        }
        // create_new (O_CREAT|O_EXCL) 原子创建文件；所有路径解析都基于已打开的根目录
        // 句柄 descriptor-relative 进行，父目录链中的 symlink 逃逸会在内核层被拒绝。
        let mut file = root.dir.open_with(&rel, OpenOptions::new().create_new(true).write(true)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("File already exists: {name}")
            } else {
                format!("Failed to create file: {e}")
            }
        })?;
        file.write_all(content.as_bytes()).map_err(|e| format!("Failed to write file: {e}"))?;
        Ok(ProjectEntryOpResult { path: root.canonical.join(&rel).to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_project_folder(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    relative_path: String,
) -> Result<ProjectEntryOpResult, String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    tokio::task::spawn_blocking(move || {
        let rel = validate_relative_path(&relative_path)?;
        let name = rel.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        validate_entry_name(&name)?;
        if let Some(parent) = rel.parent() {
            if !parent.as_os_str().is_empty() {
                root.dir.create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
            }
        }
        // create_dir 只创建叶子目录，且路径解析基于根目录句柄 descriptor-relative。
        root.dir.create_dir(&rel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("Folder already exists: {name}")
            } else {
                format!("Failed to create folder: {e}")
            }
        })?;
        Ok(ProjectEntryOpResult { path: root.canonical.join(&rel).to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_project_entry(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    relative_path: String,
    new_name: String,
) -> Result<ProjectEntryOpResult, String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    tokio::task::spawn_blocking(move || {
        let source_rel = validate_relative_path(&relative_path)?;
        validate_entry_name(&new_name)?;
        // 源路径必须存在（no-follow 元数据，不跟随最终组件 symlink）。
        root.dir.symlink_metadata(&source_rel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The file or folder no longer exists".to_string()
            } else {
                format!("Failed to access entry: {e}")
            }
        })?;
        let target_rel = match source_rel.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.join(&new_name),
            _ => PathBuf::from(&new_name),
        };
        if source_rel == target_rel {
            return Ok(ProjectEntryOpResult { path: root.canonical.join(&source_rel).to_string_lossy().to_string() });
        }
        if root.dir.try_exists(&target_rel).map_err(|e| format!("Failed to check target: {e}"))? {
            return Err(format!("A file or folder already exists: {new_name}"));
        }
        root.dir.rename(&source_rel, &root.dir, &target_rel).map_err(|e| format!("Failed to rename: {e}"))?;
        Ok(ProjectEntryOpResult { path: root.canonical.join(&target_rel).to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn count_files_recursive(dir: &Dir, depth: usize) -> u64 {
    if depth > 10 {
        return 0;
    }
    let entries = match dir.entries() {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_file() {
            count += 1;
        } else if file_type.is_dir() {
            if let Ok(sub) = dir.open_dir(Path::new(&entry.file_name())) {
                count += count_files_recursive(&sub, depth + 1);
            }
        }
    }
    count
}

/// 目录内文件数量（删除确认对话框展示影响范围用）。
#[tauri::command]
pub async fn count_project_entry_files(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    relative_path: String,
) -> Result<u64, String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    tokio::task::spawn_blocking(move || {
        let rel = validate_relative_path(&relative_path)?;
        let meta = root.dir.symlink_metadata(&rel).map_err(|e| format!("Failed to access entry: {e}"))?;
        if meta.is_file() {
            return Ok(1);
        }
        let sub = root.dir.open_dir(&rel).map_err(|e| format!("Failed to open directory: {e}"))?;
        Ok(count_files_recursive(&sub, 0))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除文件/文件夹到回收站（可恢复）。
#[tauri::command]
pub async fn delete_project_entry_to_trash(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    relative_path: String,
) -> Result<(), String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    tokio::task::spawn_blocking(move || {
        let rel = validate_relative_path(&relative_path)?;

        // 确认条目存在（no-follow 最终组件，避免跟随项目内 symlink）。
        root.dir.symlink_metadata(&rel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The file or folder no longer exists".to_string()
            } else {
                format!("Failed to access entry: {e}")
            }
        })?;

        // `trash::delete` 是路径式 API，内部会先 `canonicalize` 父目录，从而跟随被替换成
        // 外部 symlink 的中间目录组件，形成 check-then-use 的 TOCTOU 窗口。为真正关闭该
        // 窗口，这里先通过根目录句柄以 descriptor-relative 方式把条目改名到项目根目录顶层
        // （无中间路径组件、不会逃逸），再对顶层路径执行 trash。staged 名保留原条目名以便
        // 回收站中可辨识。注意：OS 回收站"还原"会指向该 staged 路径而非原始相对路径，这是
        // 基于句柄操作的安全折衷。
        let original_name = rel.file_name().and_then(|n| n.to_str()).unwrap_or("entry");
        // staged 名的固定前缀 ".dbx-trash-" + uuid(36) + "-" 共 48 字节；将原名称按
        // 字节截断到 200 字节内，确保最终名不超过常见文件系统的 NAME_MAX（255 字节）。
        let suffix = truncate_to_bytes(original_name, 200);
        let staged = format!(".dbx-trash-{}-{}", uuid::Uuid::new_v4(), suffix);
        root.dir
            .rename(&rel, &root.dir, Path::new(&staged))
            .map_err(|e| format!("Failed to stage entry for trash: {e}"))?;

        let abs = root.canonical.join(&staged);
        if let Err(e) = trash::delete(&abs) {
            // 回滚：把条目移回原位置，避免用户文件停留在顶层临时目录。
            let _ = root.dir.rename(Path::new(&staged), &root.dir, &rel);
            return Err(format!("Failed to move to trash: {e}"));
        }
        Ok(())
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
    fn truncates_names_to_byte_budget_on_char_boundary() {
        assert_eq!(truncate_to_bytes("short.sql", 200), "short.sql");
        // 100 个中文字符（每个 3 字节）应被截断到 ≤200 字节，且落在字符边界。
        let long = "中".repeat(100);
        let truncated = truncate_to_bytes(&long, 200);
        assert!(truncated.len() <= 200);
        assert!(truncated.is_char_boundary(truncated.len()));
        assert!(truncated.chars().count() < 100);
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

    // ---- symlink 越界回归测试（基于 cap-std descriptor-relative 句柄） ----

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

    /// 创建目录 symlink；平台不支持（Windows 无权限）时返回 false，调用方跳过测试。
    #[cfg(unix)]
    fn symlink_dir_available(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    fn symlink_dir_available(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    fn symlink_dir_available(_target: &Path, _link: &Path) -> bool {
        false
    }

    /// 创建文件 symlink；平台不支持（Windows 无权限）时返回 false，调用方跳过测试。
    #[cfg(unix)]
    fn symlink_file_available(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    fn symlink_file_available(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    fn symlink_file_available(_target: &Path, _link: &Path) -> bool {
        false
    }

    /// 打开临时项目根目录的 capability 句柄。
    fn open_test_dir(root: &Path) -> Dir {
        Dir::open_ambient_dir(root, ambient_authority()).unwrap()
    }

    /// 父目录是指向项目外的 symlink 时，descriptor-relative 创建应被拒绝。
    #[test]
    fn create_through_external_symlink_is_rejected() {
        let (root, outside) = setup_symlink_test_dirs();
        if !symlink_dir_available(&outside, &root.join("evil")) {
            cleanup_dirs(&[&root, &outside]);
            return;
        }
        let dir = open_test_dir(&root);
        assert!(dir.open_with("evil/new.sql", OpenOptions::new().create_new(true).write(true)).is_err());
        assert!(!outside.join("new.sql").exists(), "must not create file outside the project root");
        cleanup_dirs(&[&root, &outside]);
    }

    /// 读取通过指向项目外的 symlink 应被拒绝。
    #[test]
    fn read_through_external_symlink_is_rejected() {
        let (root, outside) = setup_symlink_test_dirs();
        std::fs::write(outside.join("secret.sql"), "SELECT 1;").unwrap();
        if !symlink_dir_available(&outside, &root.join("evil")) {
            cleanup_dirs(&[&root, &outside]);
            return;
        }
        let dir = open_test_dir(&root);
        assert!(dir.read("evil/secret.sql").is_err(), "must not read file outside the project root");
        cleanup_dirs(&[&root, &outside]);
    }

    /// rename 通过指向项目外的 symlink 应被拒绝。
    #[test]
    fn rename_through_external_symlink_is_rejected() {
        let (root, outside) = setup_symlink_test_dirs();
        std::fs::write(outside.join("victim.sql"), "SELECT 1;").unwrap();
        if !symlink_dir_available(&outside, &root.join("evil")) {
            cleanup_dirs(&[&root, &outside]);
            return;
        }
        let dir = open_test_dir(&root);
        assert!(dir.rename("evil/victim.sql", &dir, "evil/renamed.sql").is_err());
        assert!(outside.join("victim.sql").exists(), "must not rename file outside the project root");
        cleanup_dirs(&[&root, &outside]);
    }

    /// 逐组件 no-follow 打开目录时，symlink 组件应被拒绝。
    #[test]
    fn open_dir_nofollow_rejects_symlink_component() {
        let (root, outside) = setup_symlink_test_dirs();
        if !symlink_dir_available(&outside, &root.join("evil")) {
            cleanup_dirs(&[&root, &outside]);
            return;
        }
        let dir = open_test_dir(&root);
        assert!(open_dir_nofollow_components(&dir, Path::new("evil")).is_err());
        cleanup_dirs(&[&root, &outside]);
    }

    /// 逐组件 no-follow 打开目录时，普通目录应通过。
    #[test]
    fn open_dir_nofollow_accepts_normal_component() {
        let (root, _outside) = setup_symlink_test_dirs();
        std::fs::create_dir_all(root.join("subdir")).unwrap();
        let dir = open_test_dir(&root);
        assert!(open_dir_nofollow_components(&dir, Path::new("subdir")).is_ok());
        cleanup_dirs(&[&root]);
    }

    /// 嵌套 symlink（root/a/b → outside）深层路径应被拒绝。
    #[test]
    fn nested_symlink_escape_is_rejected() {
        let (root, outside) = setup_symlink_test_dirs();
        std::fs::create_dir_all(root.join("a")).unwrap();
        if !symlink_dir_available(&outside, &root.join("a").join("b")) {
            cleanup_dirs(&[&root, &outside]);
            return;
        }
        let dir = open_test_dir(&root);
        assert!(dir.read("a/b/deep.sql").is_err());
        cleanup_dirs(&[&root, &outside]);
    }

    // ---- 内部 symlink 测试：项目内 symlink 不跟随最终组件 ----

    /// 项目内 symlink 指向项目内文件：remove_file 删除 symlink 本体，不删除目标。
    #[test]
    fn remove_file_does_not_follow_symlink() {
        let (root, _outside) = setup_symlink_test_dirs();
        std::fs::write(root.join("real.sql"), "SELECT 1;").unwrap();
        if !symlink_file_available(&root.join("real.sql"), &root.join("link.sql")) {
            cleanup_dirs(&[&root]);
            return;
        }
        let dir = open_test_dir(&root);
        dir.remove_file("link.sql").unwrap();
        assert!(root.join("real.sql").exists(), "real.sql should still exist after removing link.sql");
        assert!(!root.join("link.sql").exists());
        cleanup_dirs(&[&root]);
    }

    /// 项目内 symlink 指向项目内文件：rename 移动 symlink 本体，不移动目标。
    #[test]
    fn rename_does_not_follow_symlink() {
        let (root, _outside) = setup_symlink_test_dirs();
        std::fs::write(root.join("real.sql"), "SELECT 1;").unwrap();
        if !symlink_file_available(&root.join("real.sql"), &root.join("link.sql")) {
            cleanup_dirs(&[&root]);
            return;
        }
        let dir = open_test_dir(&root);
        dir.rename("link.sql", &dir, "link_renamed.sql").unwrap();
        assert!(root.join("real.sql").exists(), "real.sql should still exist after renaming link.sql");
        assert!(root.join("link_renamed.sql").exists());
        cleanup_dirs(&[&root]);
    }

    /// 正常路径下 create/read/rename 应完整可用。
    #[test]
    fn normal_file_operations_work_within_root() {
        let (root, _outside) = setup_symlink_test_dirs();
        let dir = open_test_dir(&root);
        dir.create_dir_all("sub").unwrap();

        let mut file = dir.open_with("sub/normal.sql", OpenOptions::new().create_new(true).write(true)).unwrap();
        file.write_all(b"SELECT 1;").unwrap();
        drop(file);

        assert_eq!(dir.read("sub/normal.sql").unwrap(), b"SELECT 1;");
        dir.rename("sub/normal.sql", &dir, "sub/renamed.sql").unwrap();
        assert!(dir.try_exists("sub/renamed.sql").unwrap());
        assert!(!dir.try_exists("sub/normal.sql").unwrap());
        cleanup_dirs(&[&root]);
    }
}
