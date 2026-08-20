use serde::{Deserialize, Serialize};

/// 项目根目录的稳定文件系统身份（信任时记录、使用时校验），用于检测根目录被
/// 替换成指向项目外的 symlink/junction。Unix 取 (dev, ino)；Windows 取
/// (volume_serial, file_index)，file_index 为 0（FAT/网络盘）时以 fallback
/// (last_write_time, file_size) 兜底。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootIdentity {
    pub volume: u64,
    pub file_id: u64,
    /// Windows file_index 为 0 时的兜底标识（last_write_time, file_size）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<(u64, u64)>,
}

/// 一个 SQL 文件项目：本地文件夹 + 绑定的数据库连接等元数据。
/// 参照 DataGrip 的项目概念，一个纯存储过程项目 = 一个本地目录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlProject {
    pub id: String,
    pub name: String,
    /// 项目根目录绝对路径（canonicalize 后存储），唯一。
    pub root_path: String,
    /// 绑定的已有连接 id（connectionStore 中的 id），可为空。
    pub connection_id: Option<String>,
    /// 可选默认 schema。
    pub default_schema: Option<String>,
    /// 信任标记：首次打开未信任的项目需用户确认后才允许执行其中 SQL。
    #[serde(default)]
    pub trusted: bool,
    /// 信任时记录的根目录稳定身份；缺失时表示尚未完成身份绑定。
    #[serde(default)]
    pub root_identity: Option<RootIdentity>,
    pub created_at: String,
    pub last_opened_at: String,
}

/// 保存文件前的旧版本快照（Local History 保底，本期仅写入，UI 二期）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSnapshot {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub content: String,
    /// 快照内容的原始编码（utf8 / utf8-bom / utf16-le / utf16-be / gbk）。
    pub encoding: String,
    pub saved_at: String,
}

/// 快照列表的轻量元数据（不含 content，供 Local History 按需加载）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSnapshotMeta {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub encoding: String,
    pub saved_at: String,
    /// 快照 content 的字节数（SQLite length(content)，非字符数）。
    pub byte_len: i64,
}

/// 每个文件最多保留的快照份数，超限滚动删除最旧的。
pub const MAX_SQL_FILE_SNAPSHOTS_PER_FILE: usize = 20;

/// DBX 自管回收站条目：记录被删除条目在项目内 `.dbx-trash/` 的存储位置与原始位置，
/// 供「还原」恢复原父目录与原名（跨会话有效）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub project_id: String,
    /// 原相对路径（含父目录层级，与项目内路径一致形式）。
    pub original_relative_path: String,
    /// 原名（用于展示与还原，与 trash 内 uuid 前缀解耦）。
    pub original_name: String,
    /// `.dbx-trash/` 内的存储名（uuid 前缀，避免同名冲突）。
    pub trash_name: String,
    pub is_dir: bool,
    pub trashed_at: String,
}
