use serde::{Deserialize, Serialize};

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

/// 每个文件最多保留的快照份数，超限滚动删除最旧的。
pub const MAX_SQL_FILE_SNAPSHOTS_PER_FILE: usize = 20;
