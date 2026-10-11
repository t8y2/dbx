//! Web 权限体系数据层（多用户 / 角色 / 部门 / 登录黑名单）。
//!
//! 表结构由 [`crate::persistence::storage`] 的 `SCHEMA_STATEMENTS` 统一创建
//! （幂等 `CREATE TABLE IF NOT EXISTS`），本模块只提供 DAO 与权限聚合逻辑：
//!
//! - [`PERMISSION_*`] 权限 key 常量与 [`ALL_PERMISSIONS`] 全集；
//! - 用户 / 部门 / 角色 / 用户-角色 / 黑名单的增删改查（挂在 `Storage` 上）；
//! - [`compute_effective_permissions`]：用户所有角色的权限与数据范围取并集；
//! - 密码 90 天有效期推导（[`password_expires_in_days`] / [`is_password_expired`]）。
//!
//! 桌面端（Tauri 直连 dbx-core）不使用这些 DAO，但建表语句同样执行，多出的
//! 空表无害。

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::mcp_policy::McpConnectionGroupPath;
use crate::persistence::storage::Storage;

/// 连接管理权限：新建 / 编辑 / 删除连接配置。
pub const PERMISSION_CONNECTION_MANAGE: &str = "connection.manage";
/// 只读查询权限。
pub const PERMISSION_QUERY_READ: &str = "query.read";
/// 写操作（DML/DDL）权限。
pub const PERMISSION_QUERY_WRITE: &str = "query.write";
/// 数据传输（导入导出任务编排）权限。
pub const PERMISSION_TRANSFER: &str = "transfer";
/// SQL 文件执行权限。
pub const PERMISSION_SQLFILE_EXECUTE: &str = "sqlfile.execute";
/// 结构比较权限。
pub const PERMISSION_SCHEMA_COMPARE: &str = "schema.compare";
/// 数据比较权限。
pub const PERMISSION_DATA_COMPARE: &str = "data.compare";
/// 备份恢复权限。
pub const PERMISSION_BACKUP_RESTORE: &str = "backup.restore";
/// 数据导入权限。
pub const PERMISSION_IMPORT_DATA: &str = "import.data";
/// 数据导出权限。
pub const PERMISSION_EXPORT_DATA: &str = "export.data";

/// 全部权限 key（顺序即 `/api/auth/check` 中管理员 `permissions` 字段的顺序）。
pub const ALL_PERMISSIONS: [&str; 10] = [
    PERMISSION_CONNECTION_MANAGE,
    PERMISSION_QUERY_READ,
    PERMISSION_QUERY_WRITE,
    PERMISSION_TRANSFER,
    PERMISSION_SQLFILE_EXECUTE,
    PERMISSION_SCHEMA_COMPARE,
    PERMISSION_DATA_COMPARE,
    PERMISSION_BACKUP_RESTORE,
    PERMISSION_IMPORT_DATA,
    PERMISSION_EXPORT_DATA,
];

/// 密码有效期（秒）：90 天。
pub const PASSWORD_MAX_AGE_SECS: i64 = 90 * 24 * 60 * 60;

/// 黑名单条目类别：IP 地址。
pub const BLACKLIST_KIND_IP: &str = "ip";
/// 黑名单条目类别：用户名。
pub const BLACKLIST_KIND_USER: &str = "user";

/// 用户名规则：3-64 字符，仅 `[a-z0-9_.-]`。
const USERNAME_MIN_LEN: usize = 3;
const USERNAME_MAX_LEN: usize = 64;

/// `users` 表记录（不含角色，角色单独通过 `role_ids_of_user` 查询）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRecord {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub department_id: Option<i64>,
    pub is_admin: bool,
    /// `status = 1` 启用，`0` 禁用（禁用用户无法登录，现有会话失效）。
    pub status: bool,
    pub must_change_password: bool,
    /// Unix 秒。密码 90 天有效期的起点。
    pub password_updated_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 用户列表条目（联部门名与角色名，供管理端展示）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserSummary {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub department_id: Option<i64>,
    pub department_name: Option<String>,
    pub is_admin: bool,
    pub status: bool,
    pub must_change_password: bool,
    pub password_updated_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// 角色名列表（按 `roles.id` 排序）。
    pub roles: Vec<String>,
}

/// 部门记录（`list_departments` 附带用户数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepartmentRecord {
    pub id: i64,
    pub name: String,
    pub sort: i64,
    pub user_count: i64,
    pub created_at: i64,
}

/// 角色记录（`list_roles` 附带用户数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleRecord {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub allowed_group_ids: Vec<String>,
    pub allowed_connection_ids: Vec<String>,
    pub user_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 登录黑名单条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlacklistEntry {
    pub id: i64,
    /// `ip` 或 `user`。
    pub kind: String,
    pub value: String,
    pub reason: Option<String>,
    pub created_by: Option<String>,
    pub created_at: i64,
}

/// 用户的最终生效权限：所有角色权限与数据范围的并集。
///
/// `is_admin = true` 时 [`permissions`](Self::permissions) 为 [`ALL_PERMISSIONS`]
/// 全集；`allowed_group_ids` / `allowed_connection_ids` 为空集，调用方（路径权限
/// 中间件、MCP scope）必须先判断 `is_admin` 再解释 scope 空集的含义。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EffectivePermissions {
    pub is_admin: bool,
    pub permissions: HashSet<String>,
    pub allowed_group_ids: HashSet<String>,
    pub allowed_connection_ids: HashSet<String>,
}

impl EffectivePermissions {
    /// 管理员的最终权限：全部权限 key，scope 为空集（由调用方按 `is_admin` 放行）。
    pub fn admin() -> Self {
        Self {
            is_admin: true,
            permissions: ALL_PERMISSIONS.iter().map(|key| key.to_string()).collect(),
            allowed_group_ids: HashSet::new(),
            allowed_connection_ids: HashSet::new(),
        }
    }

    /// 是否拥有指定权限（管理员恒为 true）。
    pub fn has(&self, permission: &str) -> bool {
        self.is_admin || self.permissions.contains(permission)
    }

    /// 连接可见判定（Web 会话的数据范围，与 `dbx_core::mcp_policy::
    /// policy_allows_connection` 同构）：
    ///
    /// - 管理员，或未配置任何范围（`allowed_group_ids` 与
    ///   `allowed_connection_ids` 皆空，含无角色的用户）——全部连接可见；
    /// - 勾选了范围——连接直接命中 `allowed_connection_ids`，或其任一祖先
    ///   分组（`group_path.ids`）命中 `allowed_group_ids`（勾选分组 = 该分组
    ///   下全部连接可见；勾选单连接 = 仅该连接）。
    pub fn allows_connection(&self, group_path: Option<&McpConnectionGroupPath>, connection_id: &str) -> bool {
        if self.is_admin || (self.allowed_group_ids.is_empty() && self.allowed_connection_ids.is_empty()) {
            return true;
        }
        self.allowed_connection_ids.contains(connection_id)
            || group_path.is_some_and(|path| path.ids.iter().any(|id| self.allowed_group_ids.contains(id)))
    }
}

/// 规范化用户名：小写、3-64 字符、仅 `[a-z0-9_.-]`。
///
/// 登录时先 `to_lowercase` 再精确匹配；创建用户时调用本函数，非法输入返回
/// `Err`（错误信息可用于日志，不包含用户输入原文）。
pub fn normalize_username(raw: &str) -> Result<String, String> {
    let lowered = raw.trim().to_lowercase();
    let length = lowered.chars().count();
    if !(USERNAME_MIN_LEN..=USERNAME_MAX_LEN).contains(&length) {
        return Err(format!("username must be {USERNAME_MIN_LEN}-{USERNAME_MAX_LEN} characters (got {length})"));
    }
    if !lowered.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '.' | '-')) {
        return Err("username may only contain lowercase letters, digits, '_', '.' and '-'".to_string());
    }
    Ok(lowered)
}

/// 剩余有效天数：`ceil((password_updated_at + 90d - now) / 86400)`，下限 0。
pub fn password_expires_in_days(password_updated_at: i64, now_secs: i64) -> i64 {
    let remaining = password_updated_at.saturating_add(PASSWORD_MAX_AGE_SECS).saturating_sub(now_secs);
    if remaining <= 0 {
        return 0;
    }
    (remaining + 86_399) / 86_400
}

/// 密码是否已过期（`now > password_updated_at + 90d`，含 `must_change_password` 语义）。
pub fn is_password_expired(password_updated_at: i64, now_secs: i64) -> bool {
    now_secs > password_updated_at.saturating_add(PASSWORD_MAX_AGE_SECS)
}

/// 计算用户的最终生效权限（所有角色的权限与 scope 取并集）。
///
/// `is_admin = true` 时直接返回 [`EffectivePermissions::admin`]（视为全权限）。
pub async fn compute_effective_permissions(
    storage: &Storage,
    user: &UserRecord,
) -> Result<EffectivePermissions, String> {
    if user.is_admin {
        return Ok(EffectivePermissions::admin());
    }
    let user_id = user.id;
    let rows: Vec<(String, String)> = storage
        .with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT r.permissions_json, r.scope_json
                     FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([user_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await?;

    let mut effective = EffectivePermissions::default();
    for (permissions_json, scope_json) in rows {
        merge_role_json(&mut effective, &permissions_json, &scope_json)?;
    }
    Ok(effective)
}

/// 把单个角色的 `permissions_json` / `scope_json` 并入聚合结果。
fn merge_role_json(
    effective: &mut EffectivePermissions,
    permissions_json: &str,
    scope_json: &str,
) -> Result<(), String> {
    let permissions: Vec<String> =
        serde_json::from_str(permissions_json).map_err(|e| format!("invalid role permissions_json: {e}"))?;
    for permission in permissions {
        if !permission.is_empty() {
            effective.permissions.insert(permission);
        }
    }
    let scope: serde_json::Value =
        serde_json::from_str(scope_json).map_err(|e| format!("invalid role scope_json: {e}"))?;
    for key in ["allowed_group_ids", "allowed_connection_ids"] {
        let target = match key {
            "allowed_group_ids" => &mut effective.allowed_group_ids,
            _ => &mut effective.allowed_connection_ids,
        };
        if let Some(values) = scope.get(key).and_then(|value| value.as_array()) {
            for value in values {
                if let Some(id) = value.as_str() {
                    if !id.is_empty() {
                        target.insert(id.to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

fn user_row_mapper(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        id: row.get(0)?,
        username: row.get(1)?,
        password_hash: row.get(2)?,
        display_name: row.get(3)?,
        department_id: row.get(4)?,
        is_admin: row.get::<_, i64>(5)? != 0,
        status: row.get::<_, i64>(6)? != 0,
        must_change_password: row.get::<_, i64>(7)? != 0,
        password_updated_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const USER_COLUMNS: &str =
    "id, username, password_hash, display_name, department_id, is_admin, status, must_change_password, password_updated_at, created_at, updated_at";

fn role_row_mapper(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoleRecord> {
    let permissions_json: String = row.get(3)?;
    let scope_json: String = row.get(4)?;
    Ok(RoleRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        permissions: serde_json::from_str(&permissions_json).unwrap_or_default(),
        allowed_group_ids: parse_scope_ids(&scope_json, "allowed_group_ids"),
        allowed_connection_ids: parse_scope_ids(&scope_json, "allowed_connection_ids"),
        user_count: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn parse_scope_ids(scope_json: &str, key: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(scope_json)
        .ok()
        .and_then(|scope| scope.get(key).cloned())
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default()
}

const ROLE_COLUMNS: &str = "r.id, r.name, r.description, r.permissions_json, r.scope_json";

impl Storage {
    /// 用户总数（0 表示用户体系未初始化，走 setup 向导）。
    pub async fn count_users(&self) -> Result<i64, String> {
        self.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0)).map_err(|e| e.to_string())
        })
        .await
    }

    /// 创建用户。`username` 必须已通过 [`normalize_username`] 校验。
    ///
    /// 返回新用户 id。`password_updated_at = now`、`must_change_password = 0`。
    pub async fn create_user(
        &self,
        username: &str,
        password_hash: &str,
        display_name: Option<&str>,
        department_id: Option<i64>,
        is_admin: bool,
    ) -> Result<i64, String> {
        let username = username.to_string();
        let password_hash = password_hash.to_string();
        let display_name = display_name.map(str::to_string);
        let now = now_secs();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO users (username, password_hash, display_name, department_id, is_admin, status,
                                    must_change_password, password_updated_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6, ?6, ?6)",
                params![username, password_hash, display_name, department_id, is_admin as i64, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    /// 按用户名（调用方需先小写规范化）精确查询用户。
    pub async fn get_user_by_username(&self, username: &str) -> Result<Option<UserRecord>, String> {
        let username = username.to_string();
        self.with_conn(move |conn| {
            conn.query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE username = ?1"),
                params![username],
                user_row_mapper,
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await
    }

    /// 按用户 id 查询用户（会话校验路径）。
    pub async fn get_user_by_id(&self, user_id: i64) -> Result<Option<UserRecord>, String> {
        self.with_conn(move |conn| {
            conn.query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?1"),
                params![user_id],
                user_row_mapper,
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await
    }

    /// 用户列表（联部门名 + 角色名），按 id 升序。
    pub async fn list_users(&self) -> Result<Vec<UserSummary>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT u.id, u.username, u.display_name, u.department_id, d.name, u.is_admin, u.status,
                            u.must_change_password, u.password_updated_at, u.created_at, u.updated_at
                     FROM users u LEFT JOIN departments d ON d.id = u.department_id
                     ORDER BY u.id",
                )
                .map_err(|e| e.to_string())?;
            let mut summaries = statement
                .query_map([], |row| {
                    Ok(UserSummary {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        display_name: row.get(2)?,
                        department_id: row.get(3)?,
                        department_name: row.get(4)?,
                        is_admin: row.get::<_, i64>(5)? != 0,
                        status: row.get::<_, i64>(6)? != 0,
                        must_change_password: row.get::<_, i64>(7)? != 0,
                        password_updated_at: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                        roles: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            attach_user_roles(conn, &mut summaries)?;
            Ok(summaries)
        })
        .await
    }

    /// 更新用户基本资料（显示名 / 部门 / 是否管理员；不含密码与状态）。
    pub async fn update_user_profile(
        &self,
        user_id: i64,
        display_name: Option<&str>,
        department_id: Option<i64>,
        is_admin: bool,
    ) -> Result<(), String> {
        let display_name = display_name.map(str::to_string);
        let now = now_secs();
        self.with_conn(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE users SET display_name = ?2, department_id = ?3, is_admin = ?4, updated_at = ?5
                     WHERE id = ?1",
                    params![user_id, display_name, department_id, is_admin as i64, now],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("user {user_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 设置用户密码哈希：`password_updated_at = now`，并按参数决定是否强制
    /// 下次登录修改密码（管理员重置时传 `true`）。
    pub async fn set_user_password(
        &self,
        user_id: i64,
        password_hash: &str,
        must_change_password: bool,
    ) -> Result<(), String> {
        let password_hash = password_hash.to_string();
        let now = now_secs();
        self.with_conn(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE users SET password_hash = ?2, password_updated_at = ?3, must_change_password = ?4,
                            updated_at = ?3
                     WHERE id = ?1",
                    params![user_id, password_hash, now, must_change_password as i64],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("user {user_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 设置 / 清除 `must_change_password` 标志（不动密码与时间戳）。
    pub async fn set_must_change_password(&self, user_id: i64, must_change_password: bool) -> Result<(), String> {
        let now = now_secs();
        self.with_conn(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE users SET must_change_password = ?2, updated_at = ?3 WHERE id = ?1",
                    params![user_id, must_change_password as i64, now],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("user {user_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 启用 / 禁用用户（禁用后无法登录，现有会话在下一次请求时销毁）。
    pub async fn update_user_status(&self, user_id: i64, status: bool) -> Result<(), String> {
        let now = now_secs();
        self.with_conn(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE users SET status = ?2, updated_at = ?3 WHERE id = ?1",
                    params![user_id, status as i64, now],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("user {user_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 删除用户（连带清理 `user_roles` 关联）。
    pub async fn delete_user(&self, user_id: i64) -> Result<(), String> {
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM user_roles WHERE user_id = ?1", params![user_id]).map_err(|e| e.to_string())?;
            let changed =
                conn.execute("DELETE FROM users WHERE id = ?1", params![user_id]).map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("user {user_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 部门列表（带用户数），按 `sort` 再 `id` 排序。
    pub async fn list_departments(&self) -> Result<Vec<DepartmentRecord>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT d.id, d.name, d.sort, d.created_at, COUNT(u.id)
                     FROM departments d LEFT JOIN users u ON u.department_id = d.id
                     GROUP BY d.id, d.name, d.sort, d.created_at
                     ORDER BY d.sort, d.id",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok(DepartmentRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        sort: row.get(2)?,
                        user_count: row.get(4)?,
                        created_at: row.get(3)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    /// 创建部门，返回新 id。
    pub async fn create_department(&self, name: &str, sort: i64) -> Result<i64, String> {
        let name = name.to_string();
        let now = now_secs();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO departments (name, sort, created_at) VALUES (?1, ?2, ?3)",
                params![name, sort, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    /// 更新部门名称与排序。
    pub async fn update_department(&self, department_id: i64, name: &str, sort: i64) -> Result<(), String> {
        let name = name.to_string();
        self.with_conn(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE departments SET name = ?2, sort = ?3 WHERE id = ?1",
                    params![department_id, name, sort],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("department {department_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 删除部门：引用该部门的用户 `department_id` 置 NULL。
    pub async fn delete_department(&self, department_id: i64) -> Result<(), String> {
        self.with_conn(move |conn| {
            conn.execute("UPDATE users SET department_id = NULL WHERE department_id = ?1", params![department_id])
                .map_err(|e| e.to_string())?;
            let changed = conn
                .execute("DELETE FROM departments WHERE id = ?1", params![department_id])
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("department {department_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 角色列表（带用户数），按 id 升序。
    pub async fn list_roles(&self) -> Result<Vec<RoleRecord>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {ROLE_COLUMNS}, COUNT(ur.user_id), r.created_at, r.updated_at
                     FROM roles r LEFT JOIN user_roles ur ON ur.role_id = r.id
                     GROUP BY r.id, r.name, r.description, r.permissions_json, r.scope_json, r.created_at, r.updated_at
                     ORDER BY r.id"
                ))
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], role_row_mapper)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    /// 创建角色，返回新 id。`permissions_json` / `scope_json` 由调用方序列化。
    pub async fn create_role(
        &self,
        name: &str,
        description: Option<&str>,
        permissions_json: &str,
        scope_json: &str,
    ) -> Result<i64, String> {
        let name = name.to_string();
        let description = description.map(str::to_string);
        let permissions_json = permissions_json.to_string();
        let scope_json = scope_json.to_string();
        let now = now_secs();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO roles (name, description, permissions_json, scope_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![name, description, permissions_json, scope_json, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    /// 更新角色定义（名称 / 描述 / 权限 / 数据范围）。
    pub async fn update_role(
        &self,
        role_id: i64,
        name: &str,
        description: Option<&str>,
        permissions_json: &str,
        scope_json: &str,
    ) -> Result<(), String> {
        let name = name.to_string();
        let description = description.map(str::to_string);
        let permissions_json = permissions_json.to_string();
        let scope_json = scope_json.to_string();
        let now = now_secs();
        self.with_conn(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE roles SET name = ?2, description = ?3, permissions_json = ?4, scope_json = ?5,
                            updated_at = ?6
                     WHERE id = ?1",
                    params![role_id, name, description, permissions_json, scope_json, now],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("role {role_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 删除角色（连带清理 `user_roles` 关联）。
    pub async fn delete_role(&self, role_id: i64) -> Result<(), String> {
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM user_roles WHERE role_id = ?1", params![role_id]).map_err(|e| e.to_string())?;
            let changed =
                conn.execute("DELETE FROM roles WHERE id = ?1", params![role_id]).map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("role {role_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 覆盖式设置用户角色集合（事务内先清后插）。
    pub async fn set_user_roles(&self, user_id: i64, role_ids: &[i64]) -> Result<(), String> {
        let role_ids = role_ids.to_vec();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM user_roles WHERE user_id = ?1", params![user_id]).map_err(|e| e.to_string())?;
            for role_id in role_ids {
                conn.execute(
                    "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?1, ?2)",
                    params![user_id, role_id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
    }

    /// 查询用户的角色 id 列表（升序）。
    pub async fn role_ids_of_user(&self, user_id: i64) -> Result<Vec<i64>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("SELECT role_id FROM user_roles WHERE user_id = ?1 ORDER BY role_id")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([user_id], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    /// 查询用户的角色名列表（升序，供 `/api/auth/check` 用户形状使用）。
    pub async fn role_names_of_user(&self, user_id: i64) -> Result<Vec<String>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = ?1 ORDER BY r.id",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([user_id], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    /// 按部门 id 查询部门名（不存在或用户无部门时为 `None`）。
    pub async fn department_name_by_id(&self, department_id: Option<i64>) -> Result<Option<String>, String> {
        let Some(department_id) = department_id else {
            return Ok(None);
        };
        self.with_conn(move |conn| {
            conn.query_row("SELECT name FROM departments WHERE id = ?1", params![department_id], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())
        })
        .await
    }

    /// 黑名单全量列表（启动加载缓存用），按 id 升序。
    pub async fn list_blacklist(&self) -> Result<Vec<BlacklistEntry>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT id, kind, value, reason, created_by, created_at FROM login_blacklist ORDER BY id")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok(BlacklistEntry {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        value: row.get(2)?,
                        reason: row.get(3)?,
                        created_by: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    /// 添加黑名单条目（`UNIQUE(kind, value)`，重复插入报错）。
    pub async fn add_blacklist(
        &self,
        kind: &str,
        value: &str,
        reason: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<i64, String> {
        let kind = kind.to_string();
        let value = value.to_string();
        let reason = reason.map(str::to_string);
        let created_by = created_by.map(str::to_string);
        let now = now_secs();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO login_blacklist (kind, value, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![kind, value, reason, created_by, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    /// 按 id 移除黑名单条目。
    pub async fn remove_blacklist(&self, entry_id: i64) -> Result<(), String> {
        self.with_conn(move |conn| {
            let changed = conn
                .execute("DELETE FROM login_blacklist WHERE id = ?1", params![entry_id])
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("blacklist entry {entry_id} not found"));
            }
            Ok(())
        })
        .await
    }

    /// 判断 `(kind, value)` 是否在黑名单中。
    pub async fn is_blacklisted(&self, kind: &str, value: &str) -> Result<bool, String> {
        let kind = kind.to_string();
        let value = value.to_string();
        self.with_conn(move |conn| {
            conn.query_row("SELECT 1 FROM login_blacklist WHERE kind = ?1 AND value = ?2", params![kind, value], |_| {
                Ok(())
            })
            .optional()
            .map(|found| found.is_some())
            .map_err(|e| e.to_string())
        })
        .await
    }
}

/// 为用户列表批量附加角色名。
fn attach_user_roles(conn: &Connection, summaries: &mut [UserSummary]) -> Result<(), String> {
    let mut statement = conn
        .prepare(
            "SELECT ur.user_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id ORDER BY ur.user_id, r.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for summary in summaries.iter_mut() {
        summary.roles =
            rows.iter().filter(|(user_id, _)| *user_id == summary.id).map(|(_, name)| name.clone()).collect();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_storage() -> Storage {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.keep().join("dbx.db");
        crate::persistence::test_storage::open_unmigrated(&path).await.unwrap()
    }

    fn sample_hash(tag: &str) -> String {
        format!("argon2$fake${tag}")
    }

    #[tokio::test]
    async fn schema_creation_is_idempotent() {
        let storage = test_storage().await;
        // init_schema 在 open_unmigrated 内部执行过一次；再跑一遍不报错即幂等。
        storage
            .with_conn(|conn| {
                for kind in ["users", "departments", "roles", "user_roles", "login_blacklist"] {
                    let count: i64 = conn
                        .query_row(
                            &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{kind}'"),
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    assert_eq!(count, 1, "table {kind} must exist");
                }
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn user_crud_round_trip() {
        let storage = test_storage().await;
        assert_eq!(storage.count_users().await.unwrap(), 0);
        assert!(storage.get_user_by_username("admin").await.unwrap().is_none());

        let admin_id =
            storage.create_user("admin", &sample_hash("a"), Some("Administrator"), None, true).await.unwrap();
        assert_eq!(storage.count_users().await.unwrap(), 1);

        let admin = storage.get_user_by_id(admin_id).await.unwrap().unwrap();
        assert_eq!(admin.username, "admin");
        assert_eq!(admin.password_hash, sample_hash("a"));
        assert_eq!(admin.display_name.as_deref(), Some("Administrator"));
        assert!(admin.is_admin);
        assert!(admin.status);
        assert!(!admin.must_change_password);
        assert!(admin.password_updated_at > 0);

        // 用户名唯一约束。
        let duplicate = storage.create_user("admin", &sample_hash("b"), None, None, false).await;
        assert!(duplicate.is_err());

        // update_user_profile。
        let department_id = storage.create_department("Engineering", 1).await.unwrap();
        storage.update_user_profile(admin_id, Some("Root Admin"), Some(department_id), false).await.unwrap();
        let admin = storage.get_user_by_id(admin_id).await.unwrap().unwrap();
        assert_eq!(admin.display_name.as_deref(), Some("Root Admin"));
        assert_eq!(admin.department_id, Some(department_id));
        assert!(!admin.is_admin);

        // set_user_password 重置 must_change_password 与时间戳。
        let before = admin.password_updated_at;
        storage.set_user_password(admin_id, &sample_hash("c"), true).await.unwrap();
        let admin = storage.get_user_by_id(admin_id).await.unwrap().unwrap();
        assert_eq!(admin.password_hash, sample_hash("c"));
        assert!(admin.must_change_password);
        assert!(admin.password_updated_at >= before);
        storage.set_must_change_password(admin_id, false).await.unwrap();
        assert!(!storage.get_user_by_id(admin_id).await.unwrap().unwrap().must_change_password);

        // update_user_status。
        storage.update_user_status(admin_id, false).await.unwrap();
        assert!(!storage.get_user_by_id(admin_id).await.unwrap().unwrap().status);
        storage.update_user_status(admin_id, true).await.unwrap();

        // 删除不存在用户报错。
        assert!(storage.update_user_status(9999, false).await.is_err());
    }

    #[tokio::test]
    async fn delete_user_clears_role_links() {
        let storage = test_storage().await;
        let user_id = storage.create_user("alice", &sample_hash("a"), None, None, false).await.unwrap();
        let role_id =
            storage.create_role("dev", None, r#"["query.read"]"#, r#"{"allowed_group_ids":["g1"]}"#).await.unwrap();
        storage.set_user_roles(user_id, &[role_id]).await.unwrap();
        assert_eq!(storage.role_ids_of_user(user_id).await.unwrap(), vec![role_id]);

        storage.delete_user(user_id).await.unwrap();
        assert!(storage.get_user_by_id(user_id).await.unwrap().is_none());
        assert!(storage.role_ids_of_user(user_id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn department_crud_and_user_count() {
        let storage = test_storage().await;
        let dep_a = storage.create_department("A", 2).await.unwrap();
        let dep_b = storage.create_department("B", 1).await.unwrap();

        let u1 = storage.create_user("u1", &sample_hash("1"), None, Some(dep_a), false).await.unwrap();
        let _u2 = storage.create_user("u2", &sample_hash("2"), None, Some(dep_a), false).await.unwrap();
        let _u3 = storage.create_user("u3", &sample_hash("3"), None, None, false).await.unwrap();

        let departments = storage.list_departments().await.unwrap();
        // 按 sort 排序：B(1) 在 A(2) 前。
        assert_eq!(departments.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), vec!["B", "A"]);
        let dep_a_record = departments.iter().find(|d| d.id == dep_a).unwrap();
        assert_eq!(dep_a_record.user_count, 2);

        storage.update_department(dep_a, "A2", 5).await.unwrap();
        let departments = storage.list_departments().await.unwrap();
        assert!(departments.iter().any(|d| d.id == dep_a && d.name == "A2" && d.sort == 5));

        // 删除部门后用户 department_id 置 NULL。
        storage.delete_department(dep_b).await.unwrap();
        assert!(storage.delete_department(dep_b).await.is_err());
        let user = storage.get_user_by_id(u1).await.unwrap().unwrap();
        assert_eq!(user.department_id, Some(dep_a));
        storage.delete_department(dep_a).await.unwrap();
        assert_eq!(storage.get_user_by_id(u1).await.unwrap().unwrap().department_id, None);
    }

    #[tokio::test]
    async fn role_crud_and_listing() {
        let storage = test_storage().await;
        let role_id = storage
            .create_role(
                "analyst",
                Some("read only"),
                r#"["query.read","data.compare"]"#,
                r#"{"allowed_group_ids":["g1","g2"],"allowed_connection_ids":["c1"]}"#,
            )
            .await
            .unwrap();
        let user_id = storage.create_user("bob", &sample_hash("b"), None, None, false).await.unwrap();
        storage.set_user_roles(user_id, &[role_id]).await.unwrap();

        let roles = storage.list_roles().await.unwrap();
        let role = roles.iter().find(|r| r.id == role_id).unwrap();
        assert_eq!(role.name, "analyst");
        assert_eq!(role.description.as_deref(), Some("read only"));
        assert_eq!(role.permissions, vec!["query.read".to_string(), "data.compare".to_string()]);
        assert_eq!(role.allowed_group_ids, vec!["g1".to_string(), "g2".to_string()]);
        assert_eq!(role.allowed_connection_ids, vec!["c1".to_string()]);
        assert_eq!(role.user_count, 1);

        // set_user_roles 覆盖式更新。
        let role2 = storage.create_role("ops", None, r#"["transfer"]"#, "{}").await.unwrap();
        storage.set_user_roles(user_id, &[role2]).await.unwrap();
        assert_eq!(storage.role_ids_of_user(user_id).await.unwrap(), vec![role2]);
        // list_users 角色名跟随。
        let users = storage.list_users().await.unwrap();
        assert_eq!(users[0].roles, vec!["ops".to_string()]);

        storage
            .update_role(role_id, "analyst2", None, r#"["query.read"]"#, r#"{"allowed_connection_ids":[]}"#)
            .await
            .unwrap();
        let roles = storage.list_roles().await.unwrap();
        let role = roles.iter().find(|r| r.id == role_id).unwrap();
        assert_eq!(role.name, "analyst2");
        assert_eq!(role.permissions, vec!["query.read".to_string()]);
        assert!(role.allowed_group_ids.is_empty());

        // 删除角色连带清理 user_roles。
        storage.delete_role(role2).await.unwrap();
        assert!(storage.role_ids_of_user(user_id).await.unwrap().is_empty());
        assert!(storage.delete_role(role2).await.is_err());
    }

    #[tokio::test]
    async fn effective_permissions_union_and_admin_shortcut() {
        let storage = test_storage().await;
        let user_id = storage.create_user("carol", &sample_hash("c"), None, None, false).await.unwrap();
        let user = storage.get_user_by_id(user_id).await.unwrap().unwrap();

        // 无角色：空权限。
        let effective = compute_effective_permissions(&storage, &user).await.unwrap();
        assert!(!effective.is_admin);
        assert!(effective.permissions.is_empty());
        assert!(!effective.has(PERMISSION_QUERY_READ));

        let role_a = storage
            .create_role("a", None, r#"["query.read","query.write"]"#, r#"{"allowed_group_ids":["g1"]}"#)
            .await
            .unwrap();
        let role_b = storage
            .create_role(
                "b",
                None,
                r#"["query.read","transfer"]"#,
                r#"{"allowed_group_ids":["g2"],"allowed_connection_ids":["c1","c2"]}"#,
            )
            .await
            .unwrap();
        storage.set_user_roles(user_id, &[role_a, role_b]).await.unwrap();
        let user = storage.get_user_by_id(user_id).await.unwrap().unwrap();
        let effective = compute_effective_permissions(&storage, &user).await.unwrap();
        assert_eq!(effective.permissions.len(), 3);
        assert!(effective.has(PERMISSION_QUERY_READ));
        assert!(effective.has(PERMISSION_QUERY_WRITE));
        assert!(effective.has(PERMISSION_TRANSFER));
        assert!(!effective.has(PERMISSION_BACKUP_RESTORE));
        assert_eq!(
            effective.allowed_group_ids,
            ["g1".to_string(), "g2".to_string()].into_iter().collect::<HashSet<_>>()
        );
        assert_eq!(
            effective.allowed_connection_ids,
            ["c1".to_string(), "c2".to_string()].into_iter().collect::<HashSet<_>>()
        );

        // 管理员：全部权限（ALL_PERMISSIONS）。
        let admin_id = storage.create_user("root", &sample_hash("r"), None, None, true).await.unwrap();
        let admin = storage.get_user_by_id(admin_id).await.unwrap().unwrap();
        let effective = compute_effective_permissions(&storage, &admin).await.unwrap();
        assert!(effective.is_admin);
        assert_eq!(effective.permissions.len(), ALL_PERMISSIONS.len());
        for permission in ALL_PERMISSIONS {
            assert!(effective.has(permission));
        }
    }

    #[tokio::test]
    async fn blacklist_round_trip() {
        let storage = test_storage().await;
        assert!(!storage.is_blacklisted(BLACKLIST_KIND_IP, "10.0.0.1").await.unwrap());

        let ip_id = storage.add_blacklist(BLACKLIST_KIND_IP, "10.0.0.1", Some("abuse"), Some("admin")).await.unwrap();
        let user_id = storage.add_blacklist(BLACKLIST_KIND_USER, "mallory", None, None).await.unwrap();

        // 同一 (kind, value) 重复插入报错；不同 kind 的同值不冲突。
        assert!(storage.add_blacklist(BLACKLIST_KIND_IP, "10.0.0.1", None, None).await.is_err());
        let _other_kind = storage.add_blacklist(BLACKLIST_KIND_USER, "10.0.0.1", None, None).await.unwrap();

        assert!(storage.is_blacklisted(BLACKLIST_KIND_IP, "10.0.0.1").await.unwrap());
        assert!(!storage.is_blacklisted(BLACKLIST_KIND_IP, "10.0.0.2").await.unwrap());
        assert!(storage.is_blacklisted(BLACKLIST_KIND_USER, "mallory").await.unwrap());

        let entries = storage.list_blacklist().await.unwrap();
        assert_eq!(entries.len(), 3);
        let ip_entry = entries.iter().find(|e| e.id == ip_id).unwrap();
        assert_eq!(ip_entry.kind, BLACKLIST_KIND_IP);
        assert_eq!(ip_entry.value, "10.0.0.1");
        assert_eq!(ip_entry.reason.as_deref(), Some("abuse"));
        assert_eq!(ip_entry.created_by.as_deref(), Some("admin"));
        assert!(ip_entry.created_at > 0);
        assert_eq!(entries.iter().find(|e| e.id == user_id).unwrap().value, "mallory");

        storage.remove_blacklist(user_id).await.unwrap();
        assert!(!storage.is_blacklisted(BLACKLIST_KIND_USER, "mallory").await.unwrap());
        assert!(storage.remove_blacklist(user_id).await.is_err());
    }

    #[test]
    fn username_validation_normalizes_and_rejects() {
        assert_eq!(normalize_username("Admin").unwrap(), "admin");
        assert_eq!(normalize_username("  alice.dev-1 ").unwrap(), "alice.dev-1");
        assert!(normalize_username("ok").is_err(), "too short");
        assert!(normalize_username(&"a".repeat(65)).is_err(), "too long");
        assert!(normalize_username("bad name").is_err(), "space");
        assert!(normalize_username("中文用户").is_err(), "non ascii");
        assert!(normalize_username("bad@name").is_err(), "illegal symbol");
        assert!(normalize_username("").is_err(), "empty");
        // 64 字符合法。
        assert_eq!(normalize_username(&"a".repeat(64)).unwrap().len(), 64);
    }

    #[test]
    fn password_expiry_math() {
        const DAY: i64 = 86_400;
        let now = 1_000_000_000;
        // 刚更新：剩余整 90 天。
        assert_eq!(password_expires_in_days(now, now), 90);
        // 剩 90 天减 1 秒：ceil 为 90。
        assert_eq!(password_expires_in_days(now - 1, now), 90);
        // 剩 1 秒：ceil = 1。
        assert_eq!(password_expires_in_days(now - PASSWORD_MAX_AGE_SECS + 1, now), 1);
        // 剩半天：ceil = 1（不足一天向上取整）。
        assert_eq!(password_expires_in_days(now - PASSWORD_MAX_AGE_SECS + DAY / 2, now), 1);
        // 恰好到期：0，未过期（严格大于才算过期）。
        assert_eq!(password_expires_in_days(now - PASSWORD_MAX_AGE_SECS, now), 0);
        assert!(!is_password_expired(now - PASSWORD_MAX_AGE_SECS, now));
        // 过期 1 秒：0 且过期。
        assert_eq!(password_expires_in_days(now - PASSWORD_MAX_AGE_SECS - 1, now), 0);
        assert!(is_password_expired(now - PASSWORD_MAX_AGE_SECS - 1, now));
    }

    fn scope_fixture(group_ids: &[&str], connection_ids: &[&str]) -> EffectivePermissions {
        let mut effective = EffectivePermissions::default();
        for id in group_ids {
            effective.allowed_group_ids.insert(id.to_string());
        }
        for id in connection_ids {
            effective.allowed_connection_ids.insert(id.to_string());
        }
        effective
    }

    fn group_path(ids: &[&str]) -> crate::mcp_policy::McpConnectionGroupPath {
        crate::mcp_policy::McpConnectionGroupPath {
            ids: ids.iter().map(|id| id.to_string()).collect(),
            names: Vec::new(),
        }
    }

    #[test]
    fn allows_connection_unrestricted_when_no_scope_is_configured() {
        let unrestricted = scope_fixture(&[], &[]);
        assert!(unrestricted.allows_connection(None, "conn-1"));
        assert!(unrestricted.allows_connection(Some(&group_path(&["g1"])), "conn-1"));

        // 管理员：scope 为空集但语义上全部可见。
        let admin = EffectivePermissions::admin();
        assert!(admin.allows_connection(None, "conn-1"));
    }

    #[test]
    fn allows_connection_matches_direct_connection_or_ancestor_group() {
        let scoped = scope_fixture(&["group-a"], &["conn-solo"]);
        let in_a = group_path(&["group-a"]);
        let in_b = group_path(&["group-b"]);
        let nested_in_a = group_path(&["outer", "group-a"]);

        // 勾选单连接：仅该连接。
        assert!(scoped.allows_connection(None, "conn-solo"));
        assert!(scoped.allows_connection(Some(&in_a), "conn-other"));
        // 勾选分组：分组下全部连接可见（含嵌套）。
        assert!(scoped.allows_connection(Some(&in_a), "conn-in-a"));
        assert!(scoped.allows_connection(Some(&nested_in_a), "conn-nested"));
        // 其他分组不可见。
        assert!(!scoped.allows_connection(Some(&in_b), "conn-in-b"));
        assert!(!scoped.allows_connection(None, "conn-ungrouped"));
    }
}
