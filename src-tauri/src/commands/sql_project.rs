use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(test)]
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use dbx_core::connection::AppState;
use dbx_core::sql::{decode_sql_file_bytes_with_meta, SqlFileEncoding, SqlFileLineEnding};
use dbx_core::sql_project::{RootIdentity, SqlFileSnapshot, SqlFileSnapshotMeta, SqlProject, TrashEntry};
use serde::Serialize;
use tauri::State;

use super::external_sql::is_sql_file_path;

const MAX_SNAPSHOT_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// 根目录身份标记文件名（隐藏文件，位于项目根目录内）。
const ROOT_IDENTITY_MARKER_NAME: &str = ".dbx-root-identity";
/// 标记文件内容前缀，用于识别 DBX 写入的标记，避免误用用户同名文件的内容。
const ROOT_IDENTITY_MARKER_PREFIX: &str = "dbx-v1:";

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

    if let Some(mut existing) = state.storage.find_sql_project_by_root_path(&canonical_str).await? {
        let now = now_iso();
        state.storage.touch_sql_project(&existing.id, &now).await?;
        existing.last_opened_at = now;
        // 历史数据缺少 identity 基线：补写一次，避免后续替换检测失效。
        if existing.root_identity.is_none() {
            let identity = read_project_root_identity(&canonical).await?;
            state.storage.set_sql_project_root_identity(&existing.id, Some(&identity)).await?;
            existing.root_identity = Some(identity);
        }
        return Ok(existing);
    }

    let name = canonical.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| canonical_str.clone());
    let project = SqlProject {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        root_path: canonical_str,
        connection_id: None,
        default_schema: None,
        trusted: false,
        root_identity: None,
        created_at: now_iso(),
        last_opened_at: now_iso(),
    };
    state.storage.insert_sql_project(&project).await?;
    // 首次打开即记录根目录身份，作为后续替换检测基线（信任时也会刷新）。
    let identity = read_project_root_identity(&canonical).await?;
    state.storage.set_sql_project_root_identity(&project.id, Some(&identity)).await?;
    let mut created = project;
    created.root_identity = Some(identity);
    Ok(created)
}

/// 打开根目录句柄并读取其稳定身份（blocking 文件 IO）。
/// 同时建立/复用根目录内的身份标记文件，使 identity 能检测「删除后重建」场景。
async fn read_project_root_identity(canonical: &Path) -> Result<RootIdentity, String> {
    let canonical = canonical.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let root = ProjectRoot::open(&canonical)?;
        let mut identity = read_root_identity(&root.dir)?;
        // 建立持久化标记：目录被删除/重建后标记丢失，即使 inode 复用也能检测替换。
        // 根目录只读导致标记写入失败时降级为无标记（保留原有 (dev, ino) 校验）。
        identity.marker = read_or_create_root_identity_marker(&root.dir);
        Ok(identity)
    })
    .await
    .map_err(|e| e.to_string())?
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
    // 确认信任时记录（刷新）根目录身份，作为替换检测基线。
    if let Some(project) = state.storage.find_sql_project_by_id(&id).await? {
        let canonical = canonical_root(&project.root_path)?;
        let identity = read_project_root_identity(&canonical).await?;
        state.storage.set_sql_project_root_identity(&id, Some(&identity)).await?;
    }
    state.storage.find_sql_project_by_id(&id).await?.ok_or_else(|| "Project not found".to_string())
}

#[tauri::command]
pub async fn delete_sql_project(state: State<'_, std::sync::Arc<AppState>>, id: String) -> Result<(), String> {
    // 先尽力清理该项目回收站的磁盘文件（记录随项目 ON DELETE CASCADE 级联清掉）。
    if let Ok(Some(project)) = state.storage.find_sql_project_by_id(&id).await {
        cleanup_project_trash_files(&state, &id, &project.root_path).await;
    }
    let result = state.storage.delete_sql_project(&id).await;
    if result.is_ok() {
        // 项目已删除，释放缓存的根句柄，避免残留句柄占用。
        evict_project_root(&id);
    }
    result
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

/// 查询某文件的本地历史快照元数据列表（不含 content，按保存时间倒序）。
#[tauri::command]
pub async fn list_sql_file_snapshots_meta(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    path: String,
    limit: usize,
) -> Result<Vec<SqlFileSnapshotMeta>, String> {
    state.storage.list_sql_file_snapshot_meta(&project_id, &path, limit).await
}

/// 按 snapshot_id 获取单条快照完整内容（Local History 选中后才请求，避免一次加载 160 MiB）。
#[tauri::command]
pub async fn get_sql_file_snapshot_content(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    snapshot_id: String,
) -> Result<Option<SqlFileSnapshot>, String> {
    state.storage.get_sql_file_snapshot_content(&project_id, &snapshot_id).await
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
#[derive(Debug)]
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

    fn clone_handle(&self) -> Result<Self, String> {
        let dir = self.dir.try_clone().map_err(|e| format!("Failed to clone project root handle: {e}"))?;
        Ok(Self { canonical: self.canonical.clone(), dir })
    }
}

/// 读取根目录句柄的稳定身份（信任时记录、使用时校验）。
/// cap_fs_ext::MetadataExt 统一了跨平台 dev()/ino()：Unix 为 (dev, ino)，
/// Windows 为 (volume_serial_number, file_index)。
fn read_root_identity(dir: &Dir) -> Result<RootIdentity, String> {
    let meta = dir.dir_metadata().map_err(|e| format!("Failed to stat project root: {e}"))?;
    use cap_fs_ext::MetadataExt;
    let volume = meta.dev();
    let file_id = meta.ino();
    #[cfg(windows)]
    let fallback = {
        // 部分 FAT/网络盘 file_index 恒为 0（或取不到），无法作 identity，退化为
        // (last_write_time, file_size) 兜底（目录未被替换时保持稳定）。
        if file_id == 0 {
            use cap_std::fs::MetadataExt;
            Some((meta.last_write_time(), meta.file_size()))
        } else {
            None
        }
    };
    #[cfg(not(windows))]
    let fallback = None;
    // marker 由 read_project_root_identity 建立（根目录内标记文件 token），
    // 纯身份读取不附带标记，避免与记录值直接比较时因 marker 字段不一致而误判。
    Ok(RootIdentity { volume, file_id, fallback, marker: None })
}

/// 建立/复用根目录内的身份标记文件，返回其 token 内容。
/// - 已存在 DBX 标记（内容以 `dbx-v1:` 开头）→ 沿用，跨信任刷新保持稳定；
/// - 不存在或被外部篡改 → 写入新的随机 token；
/// - 根目录只读等写入失败 → 返回 None（降级为无标记，仅保留 (dev, ino) 校验）。
fn read_or_create_root_identity_marker(dir: &Dir) -> Option<String> {
    if let Ok(existing) = dir.read(Path::new(ROOT_IDENTITY_MARKER_NAME)) {
        if let Ok(content) = String::from_utf8(existing) {
            if content.starts_with(ROOT_IDENTITY_MARKER_PREFIX) {
                return Some(content);
            }
        }
    }
    let token = format!("{ROOT_IDENTITY_MARKER_PREFIX}{}", uuid::Uuid::new_v4());
    let mut file = dir
        .open_with(Path::new(ROOT_IDENTITY_MARKER_NAME), OpenOptions::new().create(true).write(true).truncate(true))
        .ok()?;
    file.write_all(token.as_bytes()).ok()?;
    Some(token)
}

/// 校验已打开根目录句柄的身份与信任时记录一致：(dev, ino)（含 Windows fallback）
/// 匹配，且标记文件 token 一致。目录被删除重建（inode 复用）或替换后标记丢失 → false。
fn root_identity_matches(dir: &Dir, expected: &RootIdentity) -> Result<bool, String> {
    let identity = read_root_identity(dir)?;
    if identity.volume != expected.volume || identity.file_id != expected.file_id || identity.fallback != expected.fallback {
        return Ok(false);
    }
    match &expected.marker {
        // 旧记录未绑定标记：仅校验 (dev, ino)。
        None => Ok(true),
        Some(token) => match dir.read(Path::new(ROOT_IDENTITY_MARKER_NAME)) {
            Ok(bytes) => Ok(bytes == token.as_bytes()),
            Err(_) => Ok(false),
        },
    }
}

/// 项目根目录句柄缓存（按 project_id）。信任时打开一次并绑定，之后复用，
/// 避免每次按字符串路径重新 canonicalize + open_ambient_dir：若原根目录被替换成
/// 指向项目外的 symlink/junction，缓存的句柄仍绑定原目录（Unix 上为 inode），
/// 且每次使用前用持久化 identity 校验，替换即被拒绝。
static PROJECT_ROOT_CACHE: OnceLock<Mutex<HashMap<String, ProjectRoot>>> = OnceLock::new();

fn project_root_cache() -> &'static Mutex<HashMap<String, ProjectRoot>> {
    PROJECT_ROOT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 仅测试用：清空句柄缓存，保证测试间互不影响。
#[cfg(test)]
fn clear_project_root_cache() {
    if let Some(cache) = PROJECT_ROOT_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            guard.clear();
        }
    }
}

/// 释放指定项目的缓存根句柄（项目删除/身份校验失败时调用）。
fn evict_project_root(project_id: &str) {
    if let Ok(mut cache) = project_root_cache().lock() {
        cache.remove(project_id);
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

    let mut cache = project_root_cache().lock().map_err(|_| "Project root cache poisoned".to_string())?;
    if let Some(root) = cache.get(project_id) {
        // 缓存命中：验证句柄身份与信任时记录一致，检测根目录被替换。
        let matches = match &project.root_identity {
            Some(expected) => root_identity_matches(&root.dir, expected)?,
            None => true,
        };
        if !matches {
            cache.remove(project_id);
            return Err("Project root identity mismatch (directory was replaced)".to_string());
        }
        return Ok((root.clone_handle()?, project));
    }

    // 首次使用：打开句柄并校验 identity 基线。
    let canonical = canonical_root(&project.root_path)?;
    let root = ProjectRoot::open(&canonical)?;
    match &project.root_identity {
        Some(expected) if !root_identity_matches(&root.dir, expected)? => {
            return Err("Project root identity mismatch (directory was replaced)".to_string());
        }
        _ => {}
    }
    cache.insert(project_id.to_string(), root);
    let root = cache.get(project_id).unwrap().clone_handle()?;
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
    let storage = state.storage.clone();
    // Dir 非 Copy：预克隆一个句柄供快照迁移失败时的磁盘回滚使用，
    // 避免 spawn_blocking(move) 把 root 整体移走后无法再访问。
    let rollback_dir = root.dir.try_clone().map_err(|e| format!("Failed to clone project root handle: {e}"))?;
    let canonical = root.canonical.clone();
    let renamed = tokio::task::spawn_blocking(move || {
        let source_rel = validate_relative_path(&relative_path)?;
        validate_entry_name(&new_name)?;
        // 源路径必须存在（no-follow 元数据，不跟随最终组件 symlink）。
        let meta = root.dir.symlink_metadata(&source_rel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The file or folder no longer exists".to_string()
            } else {
                format!("Failed to access entry: {e}")
            }
        })?;
        let is_dir = meta.is_dir();
        let target_rel = match source_rel.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.join(&new_name),
            _ => PathBuf::from(&new_name),
        };
        if source_rel == target_rel {
            return Ok((is_dir, source_rel, target_rel));
        }
        if root.dir.try_exists(&target_rel).map_err(|e| format!("Failed to check target: {e}"))? {
            return Err(format!("A file or folder already exists: {new_name}"));
        }
        root.dir.rename(&source_rel, &root.dir, &target_rel).map_err(|e| format!("Failed to rename: {e}"))?;
        Ok((is_dir, source_rel, target_rel))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (is_dir, source_rel, target_rel) = renamed;
    // 快照 path 迁移：失败则回滚磁盘 rename，禁止磁盘与 Local History 不一致的中间态。
    let old_rel = source_rel.to_string_lossy().into_owned();
    let new_rel = target_rel.to_string_lossy().into_owned();
    if let Err(err) = storage.rename_sql_file_snapshot_paths(&project_id, &old_rel, &new_rel, is_dir).await {
        let rollback = tokio::task::spawn_blocking(move || {
            rollback_dir
                .rename(&target_rel, &rollback_dir, &source_rel)
                .map_err(|e| format!("Failed to roll back rename: {e}"))
        })
        .await
        .map_err(|e| e.to_string())?;
        return match rollback {
            Ok(()) => Err(format!("Failed to migrate snapshot paths ({err}); rename rolled back.")),
            Err(rollback_err) => Err(format!("Failed to migrate snapshot paths ({err}); rollback also failed: {rollback_err}. Please check Local History.")),
        };
    }
    Ok(ProjectEntryOpResult { path: canonical.join(&target_rel).to_string_lossy().to_string() })
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

/// 项目内 DBX 自管回收站目录名（descriptor-relative，所有操作基于根句柄）。
const DBX_TRASH_DIR: &str = ".dbx-trash";

/// 删除文件/文件夹到 DBX 自管回收站（可还原）。
/// 流程：根句柄 move 到项目内 `.dbx-trash/{uuid}-{name}` + DB 记录还原信息；
/// move 成功但 DB 写入失败 → 回滚移回原位置，禁止「磁盘已删、DB 无记录」中间态。
#[tauri::command]
pub async fn delete_project_entry_to_trash(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    relative_path: String,
) -> Result<(), String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    let staged = tokio::task::spawn_blocking(move || -> Result<StagedTrash, String> {
        let rel = validate_relative_path(&relative_path)?;

        // 确认条目存在（no-follow 最终组件，symlink 只记录 is_dir=false，仅 move 本体）。
        let meta = root.dir.symlink_metadata(&rel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The file or folder no longer exists".to_string()
            } else {
                format!("Failed to access entry: {e}")
            }
        })?;
        let is_dir = meta.is_dir();

        // `.dbx-trash` 不存在时用根句柄创建；即使该目录已被外部替换为 symlink，
        // descriptor-relative 语义下仍落在项目内（回归问题 2 identity 校验）。
        if let Err(e) = root.dir.create_dir(Path::new(DBX_TRASH_DIR)) {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("Failed to create trash directory: {e}"));
            }
        }

        // 存储名 = uuid 前缀 + 原名（字节截断防超 NAME_MAX），同名条目各自独立还原。
        let original_name = rel.file_name().and_then(|n| n.to_str()).unwrap_or("entry").to_string();
        let suffix = truncate_to_bytes(&original_name, 200);
        let trash_name = format!("{}-{}", uuid::Uuid::new_v4(), suffix);
        let trash_rel = Path::new(DBX_TRASH_DIR).join(&trash_name);

        root.dir.rename(&rel, &root.dir, &trash_rel).map_err(|e| format!("Failed to move to trash: {e}"))?;
        Ok(StagedTrash { rel, trash_name, original_name, is_dir })
    })
    .await
    .map_err(|e| e.to_string())??;

    let StagedTrash { rel, trash_name, original_name, is_dir } = staged;
    // 用已校验的 rel（validate_relative_path 归一化后）作为 DB 中的原路径，
    // 避免闭包已 move 的原始 relative_path 二次使用。
    let original_relative_path = rel.to_string_lossy().into_owned();
    let entry = TrashEntry {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        original_relative_path,
        original_name,
        trash_name: trash_name.clone(),
        is_dir,
        trashed_at: now_iso(),
    };
    if let Err(err) = state.storage.insert_trash_entry(&entry).await {
        // 磁盘已 move、DB 写入失败 → 回滚移回原位置。
        let (root2, _project2) = resolve_trusted_root(&state, &project_id).await?;
        let rollback = tokio::task::spawn_blocking(move || {
            let trash_rel = Path::new(DBX_TRASH_DIR).join(&trash_name);
            root2.dir.rename(&trash_rel, &root2.dir, &rel).map_err(|e| format!("Failed to roll back trash move: {e}"))
        })
        .await
        .map_err(|e| e.to_string())?;
        return match rollback {
            Ok(()) => Err(format!("Failed to record trash entry ({err}); move rolled back.")),
            Err(rollback_err) => {
                Err(format!("Failed to record trash entry ({err}); rollback also failed: {rollback_err}. Please check the project .dbx-trash folder."))
            }
        };
    }
    Ok(())
}

/// 已被 move 到 `.dbx-trash/` 的条目的磁盘信息（供写 DB 与失败回滚）。
struct StagedTrash {
    rel: PathBuf,
    trash_name: String,
    original_name: String,
    is_dir: bool,
}

/// 从 DBX 回收站还原条目到原父目录 + 原名。
/// 跨会话有效（还原信息持久化在 DB）；原位置同名冲突时拒绝，不静默覆盖。
#[tauri::command]
pub async fn restore_project_entry_from_trash(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
    entry_id: String,
) -> Result<(), String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    let record = state.storage.get_trash_entry(&entry_id).await?.ok_or_else(|| "Trash entry not found".to_string())?;
    if record.project_id != project_id {
        return Err("Trash entry does not belong to this project".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let original_rel = validate_relative_path(&record.original_relative_path)?;
        let trash_rel = Path::new(DBX_TRASH_DIR).join(validate_relative_path(&record.trash_name)?);
        // 原位置已存在同名条目 → 冲突错误，不覆盖。
        if root.dir.symlink_metadata(&original_rel).is_ok() {
            return Err("An entry already exists at the original location".to_string());
        }
        root.dir.rename(&trash_rel, &root.dir, &original_rel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The trashed entry is missing (the trash directory may have been deleted)".to_string()
            } else {
                format!("Failed to restore entry: {e}")
            }
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    // move 回原位置成功 → 删除记录；重复还原同一 id 在此报错。
    state.storage.delete_trash_entry(&entry_id).await
}

/// 列出项目回收站条目（供回收站对话框展示还原/清空）。
#[tauri::command]
pub async fn list_project_trash_entries(
    state: State<'_, std::sync::Arc<AppState>>,
    project_id: String,
) -> Result<Vec<TrashEntry>, String> {
    let _ = resolve_trusted_root(&state, &project_id).await?;
    state.storage.list_trash_entries(&project_id).await
}

/// 清空项目回收站：删除 `.dbx-trash` 内对应条目并清 DB 记录。
/// 磁盘删除失败时保留其记录（可重试/还原），不静默丢数据。
#[tauri::command]
pub async fn empty_project_trash(state: State<'_, std::sync::Arc<AppState>>, project_id: String) -> Result<(), String> {
    let (root, _project) = resolve_trusted_root(&state, &project_id).await?;
    let entries = state.storage.list_trash_entries(&project_id).await?;
    if entries.is_empty() {
        return Ok(());
    }
    let removed = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let mut removed = Vec::new();
        for entry in &entries {
            let trash_rel = Path::new(DBX_TRASH_DIR).join(&entry.trash_name);
            let result =
                if entry.is_dir { root.dir.remove_dir_all(&trash_rel) } else { root.dir.remove_file(&trash_rel) };
            match result {
                Ok(()) => removed.push(entry.id.clone()),
                // 条目已丢失（回收站目录被误删等）：记录视为已清理。
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => removed.push(entry.id.clone()),
                Err(e) => {
                    return Err(format!("Failed to clear trash entry {}: {e}", entry.original_name));
                }
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())??;

    for id in removed {
        state.storage.delete_trash_entry(&id).await?;
    }
    Ok(())
}

/// 项目删除时尽力清理该项目回收站磁盘文件（记录随项目 ON DELETE CASCADE 清掉）。
/// 全程 best-effort：根目录不可访问/无权限时不阻断项目删除。
async fn cleanup_project_trash_files(state: &std::sync::Arc<AppState>, project_id: &str, root_path: &str) {
    let entries = match state.storage.list_trash_entries(project_id).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    if entries.is_empty() {
        return;
    }
    let canonical = match std::fs::canonicalize(root_path) {
        Ok(canonical) => canonical,
        Err(_) => return,
    };
    let dir = match Dir::open_ambient_dir(&canonical, ambient_authority()) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let _ = tokio::task::spawn_blocking(move || {
        for entry in &entries {
            let trash_rel = Path::new(DBX_TRASH_DIR).join(&entry.trash_name);
            let _ = if entry.is_dir { dir.remove_dir_all(&trash_rel) } else { dir.remove_file(&trash_rel) };
        }
        let _ = dir.remove_dir_all(Path::new(DBX_TRASH_DIR));
    })
    .await;
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

    // ---- 根目录 identity 绑定测试（T1） ----

    /// 辅助：创建临时项目根目录 + 临时 storage 数据目录，返回 (AppState, root, data)。
    async fn setup_project_state() -> (std::sync::Arc<AppState>, PathBuf, PathBuf) {
        use dbx_core::storage::Storage;
        let temp = std::env::temp_dir();
        let root = temp.join(format!("dbx-proj-root-{}", uuid::Uuid::new_v4()));
        let data = temp.join(format!("dbx-proj-data-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let storage = Storage::open(&data.join("storage.db")).await.unwrap();
        let state = std::sync::Arc::new(AppState::new_with_plugin_dir(storage, data.join("plugins")));
        (state, root, data)
    }

    /// 辅助：插入一条已带 identity 的项目记录。
    async fn insert_project_with_identity(state: &std::sync::Arc<AppState>, root: &Path, trusted: bool) -> SqlProject {
        let identity = read_project_root_identity(root).await.unwrap();
        let project = SqlProject {
            id: uuid::Uuid::new_v4().to_string(),
            name: "proj".to_string(),
            root_path: root.to_string_lossy().to_string(),
            connection_id: None,
            default_schema: None,
            trusted,
            root_identity: Some(identity),
            created_at: now_iso(),
            last_opened_at: now_iso(),
        };
        state.storage.insert_sql_project(&project).await.unwrap();
        project
    }

    /// 同一目录 identity 稳定，不同目录 identity 不同。
    #[test]
    fn root_identity_is_stable_per_directory() {
        let temp = std::env::temp_dir();
        let a = temp.join(format!("dbx-id-a-{}", uuid::Uuid::new_v4()));
        let b = temp.join(format!("dbx-id-b-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let dir_a = open_test_dir(&a);
        let dir_b = open_test_dir(&b);
        let id_a1 = read_root_identity(&dir_a).unwrap();
        let id_a2 = read_root_identity(&dir_a).unwrap();
        let id_b = read_root_identity(&dir_b).unwrap();
        assert_eq!(id_a1, id_a2);
        assert_ne!(id_a1, id_b);
        cleanup_dirs(&[&a, &b]);
    }

    /// RootIdentity 序列化为 camelCase 且可无损反序列化（含 marker）。
    #[test]
    fn root_identity_serde_round_trips_as_camel_case() {
        let identity = RootIdentity { volume: 123, file_id: 456, fallback: Some((789, 1011)), marker: None };
        let json = serde_json::to_string(&identity).unwrap();
        assert!(json.contains("fileId"));
        let back: RootIdentity = serde_json::from_str(&json).unwrap();
        assert_eq!(identity, back);

        let with_marker = RootIdentity { volume: 123, file_id: 456, fallback: None, marker: Some("dbx-v1:tok".to_string()) };
        let json = serde_json::to_string(&with_marker).unwrap();
        assert_eq!(json, r#"{"volume":123,"fileId":456,"marker":"dbx-v1:tok"}"#);
        let back: RootIdentity = serde_json::from_str(&json).unwrap();
        assert_eq!(with_marker, back);
    }

    /// 根目录被替换成指向项目外的 symlink/junction：即使 canonicalize 跟随了
    /// symlink 重新打开，identity 校验也会拒绝，且不会在项目外产生任何文件。
    #[tokio::test]
    async fn resolve_trusted_root_rejects_replaced_root() {
        clear_project_root_cache();
        let (state, root, data) = setup_project_state().await;
        let project = insert_project_with_identity(&state, &root, true).await;

        let replaced = root.with_extension("replaced");
        std::fs::rename(&root, &replaced).unwrap();
        let outside = data.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        if !symlink_dir_available(&outside, &root) {
            std::fs::rename(&replaced, &root).unwrap();
            cleanup_dirs(&[&root, &data]);
            return;
        }

        let err = resolve_trusted_root(&state, &project.id).await.unwrap_err();
        assert!(err.contains("identity mismatch"), "unexpected error: {err}");

        // 替换检测拒绝后，任何操作都不应落到项目外。
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none(), "must not write outside the project root");
        cleanup_dirs(&[&replaced, &data]);
    }

    /// 根目录被删除后重建同名目录：inode 可能被复用，但标记文件已随原目录丢失，
    /// identity 校验仍拒绝，不误用新目录（确定性通过，不依赖 inode 是否复用）。
    #[tokio::test]
    async fn resolve_trusted_root_rejects_deleted_and_recreated_root() {
        clear_project_root_cache();
        let (state, root, data) = setup_project_state().await;
        let project = insert_project_with_identity(&state, &root, true).await;

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::create_dir_all(&root).unwrap();

        let err = resolve_trusted_root(&state, &project.id).await.unwrap_err();
        assert!(err.contains("identity mismatch"), "unexpected error: {err}");
        cleanup_dirs(&[&root, &data]);
    }

    /// 标记文件被删除（目录对象已换过）→ 即使 (dev, ino) 与记录一致也拒绝。
    #[tokio::test]
    async fn resolve_trusted_root_rejects_deleted_marker() {
        clear_project_root_cache();
        let (state, root, data) = setup_project_state().await;
        let project = insert_project_with_identity(&state, &root, true).await;
        assert!(project.root_identity.as_ref().unwrap().marker.is_some(), "identity should carry a marker");

        std::fs::remove_file(root.join(ROOT_IDENTITY_MARKER_NAME)).unwrap();

        let err = resolve_trusted_root(&state, &project.id).await.unwrap_err();
        assert!(err.contains("identity mismatch"), "unexpected error: {err}");
        cleanup_dirs(&[&root, &data]);
    }

    /// 正常场景：多次 resolve 复用缓存句柄，项目内操作可用。
    #[tokio::test]
    async fn resolve_trusted_root_reuses_cached_handle() {
        clear_project_root_cache();
        let (state, root, data) = setup_project_state().await;
        let project = insert_project_with_identity(&state, &root, true).await;

        let (first, _) = resolve_trusted_root(&state, &project.id).await.unwrap();
        let (second, _) = resolve_trusted_root(&state, &project.id).await.unwrap();
        assert!(!first.dir.try_exists("missing").unwrap(), "handle should remain usable");
        assert!(!second.dir.try_exists("missing").unwrap());

        cleanup_dirs(&[&root, &data]);
    }

    /// 项目未信任或不存在时拒绝。
    #[tokio::test]
    async fn resolve_trusted_root_rejects_untrusted_and_missing() {
        clear_project_root_cache();
        let (state, root, data) = setup_project_state().await;
        let untrusted = insert_project_with_identity(&state, &root, false).await;

        let err = resolve_trusted_root(&state, &untrusted.id).await.unwrap_err();
        assert!(err.contains("not trusted"), "unexpected error: {err}");

        let err = resolve_trusted_root(&state, "no-such-project").await.unwrap_err();
        assert!(err.contains("not found"), "unexpected error: {err}");
        cleanup_dirs(&[&root, &data]);
    }

    /// 删除项目后，缓存的根句柄被释放；项目记录消失。
    #[tokio::test]
    async fn delete_sql_project_clears_cached_root() {
        clear_project_root_cache();
        let (state, root, data) = setup_project_state().await;
        let project = insert_project_with_identity(&state, &root, true).await;

        resolve_trusted_root(&state, &project.id).await.unwrap();
        assert!(project_root_cache().lock().unwrap().contains_key(&project.id));

        state.storage.delete_sql_project(&project.id).await.unwrap();
        evict_project_root(&project.id);
        assert!(!project_root_cache().lock().unwrap().contains_key(&project.id));

        cleanup_dirs(&[&root, &data]);
    }
}
