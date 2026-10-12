//! Web 会话的权限执行层（任务 T4）。
//!
//! 消费 [`crate::request_context`] 注入的请求用户（T3 交付），在
//! [`crate::auth::auth_middleware`] 之后执行两类判定：
//!
//! 1. **路径→权限映射**（[`access_gate_middleware`]）：已认证非 admin 的
//!    Web 会话按 [`ROUTE_PERMISSIONS`] 映射表校验 `has_permission`，缺失返回
//!    `403 {"error": "permission_denied", "permission": <key>}`。未映射端点
//!    放行（过渡态，权限模型逐步收紧）。
//! 2. **连接可见范围**（[`ensure_web_connection_scope`]）：按用户角色的
//!    `allowed_group_ids` / `allowed_connection_ids` scope 判定连接可见性，
//!    失败返回 `403 {"error": "connection_forbidden", "connectionId": ...}`。
//!    分组归属复用 `dbx_core::mcp_policy::connection_group_paths`（sidebar
//!    布局解析），判定语义与 `policy_allows_connection` 同构。
//!
//! SQL 语句在请求 body 内，中间件无法分类，因此 `/api/query/*` 执行端点在
//! handler 入口调用 [`ensure_query_permission`]：`query.read` 门 + 语句分类
//! （任一句为写动词则额外要求 `query.write`）。
//!
//! 放行范围：未认证（外层 auth 已 401）、auth 端点、静态资源、桌面直连
//! （无用户上下文）、`DBX_DISABLE_PASSWORD=1`（整体旁路，见中间件注释）、
//! `/api/admin/*`（T5 管理路由 gating 负责）。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType, TransportLayerConfig};
use dbx_core::persistence::access_control::{
    EffectivePermissions, PERMISSION_BACKUP_RESTORE, PERMISSION_CONNECTION_MANAGE, PERMISSION_DATA_COMPARE,
    PERMISSION_EXPORT_DATA, PERMISSION_IMPORT_DATA, PERMISSION_MCP, PERMISSION_SCHEMA_COMPARE,
    PERMISSION_SQLFILE_EXECUTE, PERMISSION_TRANSFER,
};
use serde_json::{json, Value};

use crate::error::AppError;
use crate::state::WebState;

// ---------------------------------------------------------------------------
// 路径→权限映射表
// ---------------------------------------------------------------------------

/// 方法过滤：`Any` 不限（前缀族的进度/下载 GET 一并覆盖）、`Post` 精确
/// 写端点。
#[derive(Clone, Copy)]
enum MethodRule {
    Any,
    Post,
}

/// 路径匹配：`Exact` 精确相等；`Prefix` 匹配自身或 `<prefix>/...` 子路径。
#[derive(Clone, Copy)]
enum PathRule {
    Exact(&'static str),
    Prefix(&'static str),
}

struct RoutePermission {
    method: MethodRule,
    path: PathRule,
    permission: &'static str,
}

impl RoutePermission {
    fn matches(&self, method: &Method, suffix: &str) -> bool {
        let method_ok = match self.method {
            MethodRule::Any => true,
            MethodRule::Post => *method == Method::POST,
        };
        method_ok
            && match self.path {
                PathRule::Exact(path) => suffix == path,
                PathRule::Prefix(prefix) => {
                    suffix == prefix || suffix.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'))
                }
            }
    }
}

/// 映射表：路径后缀（无 `/api/` 前缀，同 `auth::middleware_api_path_suffix`
/// 的返回形状）→ 权限 key。路径拼写对照 `main.rs` 路由注册行核实。
///
/// 未列出的端点放行（过渡态，风险已知：见任务交付报告）。
const ROUTE_PERMISSIONS: &[RoutePermission] = &[
    // — connection.manage：连接配置写入与布局保存 —
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/save"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/test"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/test-info"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/test-ssh-tunnel"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/mcp/add"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/mcp/duplicate"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("connection/mcp/remove"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("layout/sidebar"),
        permission: PERMISSION_CONNECTION_MANAGE,
    },
    // — transfer：传输工作流（start / ownership-preview / progress / cancel / sort） —
    RoutePermission { method: MethodRule::Any, path: PathRule::Prefix("transfer"), permission: PERMISSION_TRANSFER },
    // — sqlfile.execute：SQL 文件预览 / 执行 / 进度 / 取消 —
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("sql-file"),
        permission: PERMISSION_SQLFILE_EXECUTE,
    },
    // — schema.compare：结构比较（纯计算端点族） —
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("schema-diff"),
        permission: PERMISSION_SCHEMA_COMPARE,
    },
    // — data.compare：数据比较（含 from_tables 双连接变体） —
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("data-compare"),
        permission: PERMISSION_DATA_COMPARE,
    },
    // — backup.restore：定时备份命令 / 下载 / 还原，mongo dump 还原 —
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("database-backups"),
        permission: PERMISSION_BACKUP_RESTORE,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("mongo/dump/restore"),
        permission: PERMISSION_BACKUP_RESTORE,
    },
    // — import.data：表导入 / mongo 导入 / consul 导入执行 / nacos 配置导入 —
    RoutePermission { method: MethodRule::Any, path: PathRule::Prefix("import"), permission: PERMISSION_IMPORT_DATA },
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("mongo/import"),
        permission: PERMISSION_IMPORT_DATA,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("consul/import-execute"),
        permission: PERMISSION_IMPORT_DATA,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("nacos/configs/import/apply"),
        permission: PERMISSION_IMPORT_DATA,
    },
    // — export.data：库 / 表 / 查询结果导出与 mongo 导出 —
    RoutePermission { method: MethodRule::Any, path: PathRule::Prefix("export"), permission: PERMISSION_EXPORT_DATA },
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("mongo/export"),
        permission: PERMISSION_EXPORT_DATA,
    },
    RoutePermission {
        method: MethodRule::Post,
        path: PathRule::Exact("mongo/dump/export"),
        permission: PERMISSION_EXPORT_DATA,
    },
    // — mcp：MCP 设置页（HTTP 服务配置 / 全局策略 / 历史保留；外部 MCP 客户端
    //    端点 /mcp 有独立 token 鉴权，不在此列） —
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("app-settings/mcp-http"),
        permission: PERMISSION_MCP,
    },
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("app-settings/mcp-policy"),
        permission: PERMISSION_MCP,
    },
    RoutePermission {
        method: MethodRule::Any,
        path: PathRule::Prefix("app-settings/mcp-history-retention"),
        permission: PERMISSION_MCP,
    },
    // — 写动词端点：不做功能权限映射，改由 handler 层连接守卫
    //   （ensure_web_connection_scope）按角色数据范围的"写入更新"授权
    //   做连接级判定，见 WRITE_VERB_ENDPOINTS —
];

/// 写动词端点清单：显式数据修改端点（Redis / Mongo / Vector / 文档存储 /
/// HBase / Consul 前缀删除），这些端点的 handler 均经
/// [`ensure_web_connection_scope`] 守卫，在其上追加连接级写入授权判定
/// （[`EffectivePermissions::allows_query_write`]：角色数据范围树上
/// 勾选"写入更新"的连接才可写，未勾选连接一律只读）。
/// `/api/query/*` 执行端点不在此列——按 SQL 语句分类在
/// [`ensure_query_permission`] 内判定。
const WRITE_VERB_ENDPOINTS: &[&str] = &[
    "redis/execute-command",
    "redis/flush-db",
    "mongo/run-command",
    "mongo/drop-database",
    "mongo/drop-collection",
    "mongo/insert-document",
    "mongo/insert-documents",
    "mongo/update-document",
    "mongo/update-documents",
    "mongo/delete-document",
    "mongo/delete-documents",
    "mongo/bulk-write",
    "vector/drop-database",
    "vector/drop-collection",
    "document-store/elasticsearch/documents/delete-all",
    "document-store/create-gridfs-bucket",
    "document-store/delete-gridfs-bucket",
    "document-store/upload-gridfs-file",
    "document-store/delete-gridfs-file",
    "document-store/insert-document",
    "document-store/update-document",
    "document-store/delete-document",
    "document-store/save-meilisearch-batch",
    "document-store/meilisearch/settings/update",
    "document-store/meilisearch/index/create",
    "document-store/meilisearch/index/delete",
    "document-store/meilisearch/keys/create",
    "document-store/meilisearch/keys/update",
    "document-store/meilisearch/keys/delete",
    "document-store/meilisearch/tasks/cancel",
    "document-store/meilisearch/tasks/delete",
    "document-store/meilisearch/documents/delete-all",
    "hbase/create-table",
    "hbase/delete-table",
    "hbase/put-row",
    "hbase/delete-row",
    "consul/delete-prefix-execute",
];

/// 当前请求是否落在写动词端点上（[`WRITE_VERB_ENDPOINTS`] 精确清单；
/// `mq-admin` feature 下追加 `mq` 前缀——非 GET 即写，与原中间件 NonGet
/// 语义一致，GET 状态查询不要求写入授权）。
fn is_write_verb_endpoint(path_suffix: &str, is_get: bool) -> bool {
    if WRITE_VERB_ENDPOINTS.contains(&path_suffix) {
        return true;
    }
    #[cfg(feature = "mq-admin")]
    if !is_get && (path_suffix == "mq" || path_suffix.starts_with("mq/")) {
        return true;
    }
    false
}

/// 解析路径后缀（无 `/api/` 前缀）与方法所需的权限 key；未映射返回 `None`。
pub(crate) fn required_permission(method: &Method, path_suffix: &str) -> Option<&'static str> {
    ROUTE_PERMISSIONS.iter().find(|rule| rule.matches(method, path_suffix)).map(|rule| rule.permission)
}

// ---------------------------------------------------------------------------
// 中间件
// ---------------------------------------------------------------------------

/// 权限执行中间件：挂在 `auth_middleware` 之后的 `/api` 内层链末端
/// （`main.rs` 中间件链最内层，最后执行）。
pub async fn access_gate_middleware(State(state): State<Arc<WebState>>, req: Request, next: Next) -> Response {
    // DBX_DISABLE_PASSWORD=1：用户体系关闭，权限执行层整体旁路（全放行）。
    // 已知风险：此模式下无任何权限隔离，仅适用于可信的单用户部署；与
    // auth_middleware 的放行语义一致（T3）。
    if state.password_disabled {
        return next.run(req).await;
    }
    // auth_middleware（外层）已注入请求用户；None = auth 端点 / 静态资源 /
    // 桌面直连（无中间件链），一律放行。未认证请求到不了这里（外层 401）。
    let Some(user) = crate::request_context::current_request_user() else {
        return next.run(req).await;
    };
    if user.is_admin {
        return next.run(req).await;
    }
    let Some(suffix) = crate::auth::middleware_api_path_suffix(req.uri().path(), &state.public_base_path) else {
        return next.run(req).await;
    };
    // /api/admin/*：T5 管理路由的 gating 负责（WebState::admin_gating_response
    // 与角色管理权限），此处放行。
    if suffix == "admin" || suffix.starts_with("admin/") {
        return next.run(req).await;
    }
    match required_permission(req.method(), suffix) {
        Some(permission) if !user.has_permission(permission) => permission_denied_response(permission),
        _ => next.run(req).await,
    }
}

// ---------------------------------------------------------------------------
// 稳定错误码构造
// ---------------------------------------------------------------------------

/// 中间件层 403：`{"error": "permission_denied", "permission": <key>}`。
fn permission_denied_response(permission: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "permission_denied", "permission": permission }))).into_response()
}

/// handler 层连接不可见 403：`{"error": "connection_forbidden", "connectionId": ...}`。
pub fn connection_forbidden_app_error(connection_id: &str) -> AppError {
    AppError::forbidden_json(json!({ "error": "connection_forbidden", "connectionId": connection_id }))
}

/// `handler` 层连接不可写 403（角色数据范围未勾选该连接的"写入更新"）：
/// `{"error": "query_write_forbidden", "connectionId": ...}`。
pub fn query_write_forbidden_app_error(connection_id: &str) -> AppError {
    AppError::forbidden_json(json!({ "error": "query_write_forbidden", "connectionId": connection_id }))
}

// ---------------------------------------------------------------------------
// 连接可见范围守卫
// ---------------------------------------------------------------------------

/// Web 会话的连接可见范围守卫（任务 B 统一 helper）。
///
/// - 无用户上下文（桌面直连 / `DBX_DISABLE_PASSWORD=1` / auth 端点）：放行；
/// - admin 或未配置 scope（两集合皆空）：放行；
/// - 否则按 [`EffectivePermissions::allows_connection`] 判定，失败返回
///   `403 connection_forbidden`；
/// - 当前请求落在写动词端点（[`is_write_verb_endpoint`]）时，追加连接级
///   写入授权判定 [`EffectivePermissions::allows_query_write`]（角色数据
///   范围树"写入更新"勾选），失败返回 `403 query_write_forbidden`——
///   未勾选的连接一律只读。
///
/// MCP 请求（`x-dbx-mcp-request: 1`）不走本函数——`routes::mcp_policy` 的
/// 守卫在 MCP 分支维持 `McpGlobalPolicy` 原逻辑，Web 分支调用本函数。
pub async fn ensure_web_connection_scope(state: &Arc<WebState>, connection_id: &str) -> Result<(), AppError> {
    let Some(user) = crate::request_context::current_request_user() else {
        return Ok(());
    };
    if user.is_admin {
        return Ok(());
    }
    // scope 为空（未配置数据范围或无角色）：非 admin 无权访问任何连接。
    if user.permissions.allowed_group_ids.is_empty() && user.permissions.allowed_connection_ids.is_empty() {
        return Err(connection_forbidden_app_error(connection_id));
    }
    let group_paths = load_connection_group_paths(state).await?;
    if !user.permissions.allows_connection(group_paths.get(connection_id), connection_id) {
        return Err(connection_forbidden_app_error(connection_id));
    }
    // 写动词端点：可见即可读，可写需授权——数据范围树上"写入更新"未勾选
    // 的连接一律拒绝写操作。
    let is_get = user.api_method.as_deref() == Some("GET");
    if user.api_path_suffix.as_deref().is_some_and(|suffix| is_write_verb_endpoint(suffix, is_get))
        && !user.permissions.allows_query_write(group_paths.get(connection_id), connection_id)
    {
        return Err(query_write_forbidden_app_error(connection_id));
    }
    Ok(())
}

/// 从持久化 sidebar 布局解析连接→分组路径映射；布局缺失或解析失败按空
/// 映射处理（此时仅 `allowed_connection_ids` 直接命中可见）。
///
/// 结果带缓存：以 `Storage::layout_version()` 为版本号，命中即返回共享
/// `Arc`，避免权限热路径（连接守卫/可见性过滤每请求一次）重复读 SQLite
/// 与解析布局 JSON；布局保存使版本自增后自动失效重新加载。
pub(crate) async fn load_connection_group_paths(
    state: &Arc<WebState>,
) -> Result<Arc<HashMap<String, dbx_core::mcp_policy::McpConnectionGroupPath>>, AppError> {
    let revision = state.app.storage.layout_version();
    if let Some((cached_revision, cached)) = state.group_paths_cache.read().await.as_ref() {
        if *cached_revision == revision {
            return Ok(cached.clone());
        }
    }
    let layout = state.app.storage.load_sidebar_layout().await.map_err(AppError::from)?;
    let map = match layout {
        Some(layout) => dbx_core::mcp_policy::connection_group_paths(&layout).map_err(AppError::from)?,
        None => HashMap::new(),
    };
    let map = Arc::new(map);
    // 仅当读取布局期间布局未被改写时才回写缓存，避免把旧布局数据标成
    // 新修订号（本次调用仍返回本次读到的映射，下一次请求会重新加载）。
    let now = state.app.storage.layout_version();
    if now == revision {
        *state.group_paths_cache.write().await = Some((now, map.clone()));
    }
    Ok(map)
}

/// 按用户 scope 过滤连接列表（任务 C.1）。
///
/// - 管理员（`is_admin`）：原样返回全部连接；
/// - 非管理员且 scope 为空（未配置数据范围或无角色）：返回空列表；
/// - 非管理员且 scope 非空：仅保留命中 `allowed_connection_ids` 或
///   `allowed_group_ids` 的连接。
pub(crate) async fn visible_connections_for_scope(
    state: &Arc<WebState>,
    configs: Vec<ConnectionConfig>,
    scope: &EffectivePermissions,
) -> Result<Vec<ConnectionConfig>, AppError> {
    if scope.is_admin {
        return Ok(configs);
    }
    if scope.allowed_group_ids.is_empty() && scope.allowed_connection_ids.is_empty() {
        return Ok(Vec::new());
    }
    let group_paths = load_connection_group_paths(state).await?;
    Ok(configs.into_iter().filter(|config| scope.allows_connection(group_paths.get(&config.id), &config.id)).collect())
}

// ---------------------------------------------------------------------------
// SQL 语句分类（连接级写入授权）
// ---------------------------------------------------------------------------

/// 查询执行端点的语句权限门（`handler` 入口调用；语句在 body 内，中间件
/// 无法分类）。
///
/// - 无用户上下文 / admin：放行；
/// - 可见即可读：连接在角色数据范围内即可执行只读语句（查询不再有独立
///   功能权限）；
/// - 任一语句为写动词（INSERT/UPDATE/DELETE/DDL 等，复用
///   `dbx_core::query_execution_sql::is_write_sql_for_database` 分类器）：
///   按角色数据范围的写入授权
///   ([`EffectivePermissions::allows_query_write`]) 做连接级判定，未授权
///   返回 `403 query_write_forbidden`——写入按连接/分组单独授权
///   （数据范围树"写入更新"勾选），未经勾选的连接只读。
pub async fn ensure_query_permission(
    state: &Arc<WebState>,
    connection_id: &str,
    statements: &[String],
) -> Result<(), AppError> {
    let Some(user) = crate::request_context::current_request_user() else {
        return Ok(());
    };
    if statements.is_empty() {
        return Ok(());
    }
    let db_type = load_connection_db_type(state, connection_id).await;
    for statement in statements {
        let is_write = db_type
            .map(|db_type| dbx_core::query_execution_sql::is_write_sql_for_database(statement, db_type))
            .unwrap_or_else(|| dbx_core::query_execution_sql::is_write_sql(statement));
        if is_write {
            if !user
                .permissions
                .allows_query_write(load_connection_group_paths(state).await?.get(connection_id), connection_id)
            {
                return Err(query_write_forbidden_app_error(connection_id));
            }
            // 已确认写权限：后续语句无需再分类。
            return Ok(());
        }
    }
    Ok(())
}

/// 从运行时连接缓存读取 db_type（与 `routes::query::execute_script` 的
/// 读取模式一致；缓存未命中返回 `None`，分类退化为通用 SQL 关键词版）。
async fn load_connection_db_type(state: &Arc<WebState>, connection_id: &str) -> Option<DatabaseType> {
    let configs = state.app.configs.read().await;
    configs.get(connection_id).map(|config| config.db_type)
}

/// 多语句脚本版：按连接方言分割后逐句分类（任一写句要求连接写入授权）。
/// 供 `execute_query` / `execute_multi` 等以单一 SQL 文本为入参的执行端点使用。
pub async fn ensure_query_script_permission(
    state: &Arc<WebState>,
    connection_id: &str,
    sql: &str,
) -> Result<(), AppError> {
    let db_type = load_connection_db_type(state, connection_id).await;
    let statements = db_type
        .map(|db_type| dbx_core::sql::split_sql_statements_for_database(sql, db_type))
        .unwrap_or_else(|| dbx_core::sql::split_sql_statements(sql));
    ensure_query_permission(state, connection_id, &statements).await
}

/// DDL 性质端点版（如 `apply-sqlite-table-structure-change`）：不携带可分类
/// 的原始 SQL，直接按写入范围做连接级判定（可见即可读，可写需"写入更新"
/// 勾选）。
pub async fn ensure_query_write_permission(state: &Arc<WebState>, connection_id: &str) -> Result<(), AppError> {
    let Some(user) = crate::request_context::current_request_user() else {
        return Ok(());
    };
    if !user.permissions.allows_query_write(load_connection_group_paths(state).await?.get(connection_id), connection_id)
    {
        return Err(query_write_forbidden_app_error(connection_id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 连接敏感字段抹除（任务 C.1）
// ---------------------------------------------------------------------------

/// 抹除响应中的连接敏感字段（无 `connection.manage` 权限的用户）。
///
/// 字段清单对照 `ConnectionConfig` 序列化与 Debug 输出的 redaction 语义
/// （`redact_connection_debug_value`）：连接密码、Redis 哨兵密码、插件密钥
/// 映射、各传输层凭据（SSH 密码/口令、代理密码、HTTP 隧道令牌）、可内嵌
/// 凭据的连接串与初始化脚本。
pub(crate) fn redact_connection_sensitive_fields(config: &mut ConnectionConfig) {
    config.password.clear();
    config.redis_sentinel_password.clear();
    config.connection_secrets.clear();
    config.connection_string = None;
    config.init_script = None;
    for layer in &mut config.transport_layers {
        match layer {
            TransportLayerConfig::Ssh(layer) => {
                layer.password.clear();
                layer.key_passphrase.clear();
            }
            TransportLayerConfig::Proxy(layer) => layer.password.clear(),
            TransportLayerConfig::HttpTunnel(layer) => layer.token.clear(),
        }
    }
}

// ---------------------------------------------------------------------------
// 侧边栏布局过滤（任务 C.2）
// ---------------------------------------------------------------------------

/// 按用户 scope 过滤 sidebar 布局（纯函数，`Value` 层操作）。
///
/// - admin：原样返回；
/// - 非 admin 且 scope 为空：返回空布局（无连接可见）；
/// - 顶层与分组内的不可见连接条目移除；过滤后不含任何可见连接且自身未被
///   勾选的分组整个移除（分组命中 `allowed_group_ids` 时保留分组节点，其下
///   不可见连接仍移除）；
/// - `groups` 元数据同步裁剪为仍被引用的分组；未识别的布局形状原样返回。
pub(crate) fn filter_sidebar_layout_for_scope(mut layout: Value, scope: &EffectivePermissions) -> Value {
    if scope.is_admin {
        return layout;
    }
    if scope.allowed_group_ids.is_empty() && scope.allowed_connection_ids.is_empty() {
        // scope 为空：非 admin 无权看到任何连接，清空布局。
        if let Some(order) = layout.get_mut("order").and_then(Value::as_array_mut) {
            order.clear();
        }
        if let Some(groups) = layout.get_mut("groups").and_then(Value::as_object_mut) {
            groups.clear();
        }
        return layout;
    }
    let group_paths = dbx_core::mcp_policy::connection_group_paths(&layout).unwrap_or_default();
    let Some(order) = layout.get_mut("order").and_then(Value::as_array_mut) else {
        return layout;
    };
    order.retain_mut(|entry| retain_sidebar_entry(entry, scope, &group_paths));
    prune_unreferenced_layout_groups(&mut layout);
    layout
}

fn retain_sidebar_entry(
    entry: &mut Value,
    scope: &EffectivePermissions,
    group_paths: &HashMap<String, dbx_core::mcp_policy::McpConnectionGroupPath>,
) -> bool {
    match entry.get("type").and_then(Value::as_str) {
        Some("connection") => {
            entry.get("id").and_then(Value::as_str).is_some_and(|id| scope.allows_connection(group_paths.get(id), id))
        }
        Some("group") => {
            let group_id = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let has_visible_descendant = if let Some(children) = entry.get_mut("children").and_then(Value::as_array_mut)
            {
                children.retain_mut(|child| retain_sidebar_entry(child, scope, group_paths));
                !children.is_empty()
            } else if let Some(connection_ids) = entry.get_mut("connectionIds").and_then(Value::as_array_mut) {
                connection_ids.retain(|id| {
                    id.as_str().is_some_and(|connection_id| {
                        scope.allows_connection(group_paths.get(connection_id), connection_id)
                    })
                });
                !connection_ids.is_empty()
            } else {
                false
            };
            // 分组勾选可见（命中 allowed_group_ids）或仍含可见后代时保留。
            scope.allowed_group_ids.contains(&group_id) || has_visible_descendant
        }
        // 未识别条目类型：保留（向前兼容前端扩展）。
        _ => true,
    }
}

fn prune_unreferenced_layout_groups(layout: &mut Value) {
    let mut referenced = HashSet::new();
    if let Some(order) = layout.get("order").and_then(Value::as_array) {
        collect_referenced_group_ids(order, &mut referenced);
    }
    if let Some(groups) = layout.get_mut("groups").and_then(Value::as_array_mut) {
        groups.retain(|group| group.get("id").and_then(Value::as_str).is_some_and(|id| referenced.contains(id)));
    }
}

fn collect_referenced_group_ids(entries: &[Value], referenced: &mut HashSet<String>) {
    for entry in entries {
        match entry.get("type").and_then(Value::as_str) {
            Some("group") => {
                if let Some(id) = entry.get("id").and_then(Value::as_str) {
                    referenced.insert(id.to_string());
                }
                if let Some(children) = entry.get("children").and_then(Value::as_array) {
                    collect_referenced_group_ids(children, referenced);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn method(name: &str) -> Method {
        Method::from_bytes(name.as_bytes()).unwrap()
    }

    #[test]
    fn mapping_resolves_exact_write_endpoints() {
        // 写动词端点不做功能权限映射（改为 handler 层连接级写入授权判定），
        // 但必须落在 WRITE_VERB_ENDPOINTS 清单内。
        for path in
            ["redis/flush-db", "mongo/bulk-write", "document-store/meilisearch/documents/delete-all", "hbase/put-row"]
        {
            assert_eq!(required_permission(&method("POST"), path), None);
            assert!(is_write_verb_endpoint(path, false));
        }
        assert_eq!(required_permission(&method("POST"), "connection/save"), Some(PERMISSION_CONNECTION_MANAGE));
        assert_eq!(required_permission(&method("POST"), "layout/sidebar"), Some(PERMISSION_CONNECTION_MANAGE));
        assert_eq!(required_permission(&method("POST"), "consul/import-execute"), Some(PERMISSION_IMPORT_DATA));
        assert_eq!(required_permission(&method("POST"), "nacos/configs/import/apply"), Some(PERMISSION_IMPORT_DATA));
        assert_eq!(required_permission(&method("POST"), "mongo/dump/restore"), Some(PERMISSION_BACKUP_RESTORE));
        assert_eq!(required_permission(&method("POST"), "mongo/dump/export"), Some(PERMISSION_EXPORT_DATA));
    }

    #[test]
    fn mapping_resolves_prefix_families_including_get_progress_and_download() {
        // query 前缀不再映射功能权限：执行端点按 SQL 语句分类判定
        // （ensure_query_permission），其余查询辅助端点仅受连接可见范围约束。
        assert_eq!(required_permission(&method("POST"), "query/execute"), None);
        assert_eq!(required_permission(&method("POST"), "query/execute-script-2pc"), None);
        assert_eq!(required_permission(&method("GET"), "query/build-sorted-sql"), None);
        assert!(!is_write_verb_endpoint("query/execute", false));
        assert_eq!(required_permission(&method("POST"), "transfer/start"), Some(PERMISSION_TRANSFER));
        assert_eq!(required_permission(&method("GET"), "transfer/progress/t-1"), Some(PERMISSION_TRANSFER));
        assert_eq!(required_permission(&method("POST"), "sql-file/execute"), Some(PERMISSION_SQLFILE_EXECUTE));
        assert_eq!(required_permission(&method("GET"), "sql-file/progress/e-1"), Some(PERMISSION_SQLFILE_EXECUTE));
        assert_eq!(required_permission(&method("POST"), "schema-diff/prepare"), Some(PERMISSION_SCHEMA_COMPARE));
        assert_eq!(required_permission(&method("POST"), "data-compare/from-tables"), Some(PERMISSION_DATA_COMPARE));
        assert_eq!(required_permission(&method("POST"), "import/execute"), Some(PERMISSION_IMPORT_DATA));
        assert_eq!(required_permission(&method("GET"), "import/progress/i-1"), Some(PERMISSION_IMPORT_DATA));
        assert_eq!(required_permission(&method("POST"), "mongo/import/execute"), Some(PERMISSION_IMPORT_DATA));
        assert_eq!(required_permission(&method("POST"), "export/database"), Some(PERMISSION_EXPORT_DATA));
        assert_eq!(required_permission(&method("GET"), "export/database/download/e-1"), Some(PERMISSION_EXPORT_DATA));
        assert_eq!(required_permission(&method("POST"), "mongo/export"), Some(PERMISSION_EXPORT_DATA));
        assert_eq!(required_permission(&method("GET"), "mongo/export/progress/e-1"), Some(PERMISSION_EXPORT_DATA));
        // database-backups 前缀（POST command / GET download / POST restore）。
        assert_eq!(required_permission(&method("POST"), "database-backups"), Some(PERMISSION_BACKUP_RESTORE));
        assert_eq!(
            required_permission(&method("GET"), "database-backups/b-1/files/0"),
            Some(PERMISSION_BACKUP_RESTORE)
        );
        assert_eq!(
            required_permission(&method("POST"), "database-backups/b-1/files/0/restore"),
            Some(PERMISSION_BACKUP_RESTORE)
        );
    }

    #[test]
    fn mapping_prefix_does_not_capture_sibling_paths() {
        // "import" 前缀不得误伤 "importer/..." 或 "mongo/import-x"。
        assert_eq!(required_permission(&method("POST"), "importer/run"), None);
        assert_eq!(required_permission(&method("POST"), "mongo/import-batch"), None);
        // "export" 前缀不含 "exporter"。
        assert_eq!(required_permission(&method("POST"), "exporter/run"), None);
        // "mongo/export" 前缀不含 "mongo/exporter"。
        assert_eq!(required_permission(&method("POST"), "mongo/exporter/run"), None);
    }

    #[test]
    fn mapping_leaves_unmapped_and_read_only_endpoints_alone() {
        assert_eq!(required_permission(&method("GET"), "connection/list"), None);
        assert_eq!(required_permission(&method("POST"), "connection/connect"), None);
        assert_eq!(required_permission(&method("GET"), "layout/sidebar"), None);
        assert_eq!(required_permission(&method("GET"), "history"), None);
        assert_eq!(required_permission(&method("POST"), "ai/complete"), None);
        assert_eq!(required_permission(&method("POST"), "consul/put"), None);
        assert_eq!(required_permission(&method("POST"), "nacos/configs/publish"), None);
        // 读动词文档存储端点不在写动词清单内（scope 守卫仍生效）。
        assert_eq!(required_permission(&method("POST"), "document-store/find-documents"), None);
        assert!(!is_write_verb_endpoint("document-store/find-documents", false));
        assert_eq!(required_permission(&method("POST"), "mongo/find-documents"), None);
        assert_eq!(required_permission(&method("POST"), "hbase/scan-rows"), None);
    }

    #[cfg(feature = "mq-admin")]
    #[test]
    fn mq_prefix_counts_as_write_verb_for_non_get_only() {
        // MQ 写动词改由连接级写入授权判定（非 GET 即写，GET 状态查询只读）。
        assert!(is_write_verb_endpoint("mq/consume", false));
        assert!(is_write_verb_endpoint("mq/topic/create", false));
        assert!(!is_write_verb_endpoint("mq/status", true));
    }

    #[test]
    fn sql_write_classification_covers_dml_ddl_and_multi_statement_mix() {
        // 复用的分类器行为快照：SELECT 放行、写动词命中、脚本混入写句命中。
        assert!(!dbx_core::query_execution_sql::is_write_sql("SELECT 1"));
        assert!(dbx_core::query_execution_sql::is_write_sql("UPDATE t SET a = 1"));
        assert!(dbx_core::query_execution_sql::is_write_sql("DELETE FROM t"));
        assert!(dbx_core::query_execution_sql::is_write_sql("DROP TABLE t"));
        assert!(dbx_core::query_execution_sql::is_write_sql("CREATE TABLE t (id INT)"));
        assert!(!dbx_core::query_execution_sql::is_write_sql("EXPLAIN SELECT 1"));
    }

    fn scope_fixture(group_ids: &[&str], connection_ids: &[&str]) -> EffectivePermissions {
        let mut scope = EffectivePermissions::default();
        for id in group_ids {
            scope.allowed_group_ids.insert(id.to_string());
        }
        for id in connection_ids {
            scope.allowed_connection_ids.insert(id.to_string());
        }
        scope
    }

    fn sample_layout() -> Value {
        json!({
            "groups": [
                { "id": "group-a", "name": "Group A" },
                { "id": "group-b", "name": "Group B" },
            ],
            "order": [
                { "type": "connection", "id": "conn-loose" },
                { "type": "group", "id": "group-a", "children": [
                    { "type": "connection", "id": "conn-a1" },
                    { "type": "connection", "id": "conn-a2" },
                ]},
                { "type": "group", "id": "group-b", "connectionIds": ["conn-b1"] },
            ],
        })
    }

    #[test]
    fn sidebar_filter_keeps_only_selected_group_and_prunes_empty_groups() {
        let filtered = filter_sidebar_layout_for_scope(sample_layout(), &scope_fixture(&["group-a"], &[]));

        let order = filtered["order"].as_array().unwrap();
        assert_eq!(order.len(), 1, "loose connection and group-b must be removed: {filtered}");
        assert_eq!(order[0]["type"], "group");
        assert_eq!(order[0]["id"], "group-a");
        let children = order[0]["children"].as_array().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0]["id"], "conn-a1");
        assert_eq!(children[1]["id"], "conn-a2");

        let groups = filtered["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["id"], "group-a");
    }

    #[test]
    fn sidebar_filter_keeps_group_with_single_pinned_connection_only() {
        // 分组未勾选，但分组内单勾选一个连接：分组保留、其余连接移除。
        let filtered = filter_sidebar_layout_for_scope(sample_layout(), &scope_fixture(&[], &["conn-a2"]));

        let order = filtered["order"].as_array().unwrap();
        assert_eq!(order.len(), 1);
        let group = &order[0];
        assert_eq!(group["id"], "group-a");
        let children = group["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["id"], "conn-a2");
    }

    #[test]
    fn sidebar_filter_clear_layout_for_empty_scope_and_keeps_admin_untouched() {
        let layout = sample_layout();
        // 非 admin 且 scope 为空：布局清空（无连接可见）。
        let empty = filter_sidebar_layout_for_scope(layout.clone(), &scope_fixture(&[], &[]));
        assert!(empty["order"].as_array().unwrap().is_empty());
        assert!(empty["groups"].as_array().unwrap().is_empty());
        // admin：布局原样返回。
        let admin = EffectivePermissions::admin();
        assert_eq!(filter_sidebar_layout_for_scope(layout, &admin), sample_layout());
    }

    #[test]
    fn sidebar_filter_keeps_legacy_connection_ids_group_shape() {
        let filtered = filter_sidebar_layout_for_scope(sample_layout(), &scope_fixture(&[], &["conn-b1"]));

        let order = filtered["order"].as_array().unwrap();
        assert_eq!(order.len(), 1);
        assert_eq!(order[0]["id"], "group-b");
        let ids = order[0]["connectionIds"].as_array().unwrap();
        assert_eq!(ids, &vec![json!("conn-b1")]);
    }

    #[test]
    fn redact_clears_all_sensitive_fields() {
        let mut config: ConnectionConfig = serde_json::from_value(json!({
            "id": "conn-1",
            "name": "demo",
            "db_type": "mysql",
            "host": "localhost",
            "port": 3306,
            "username": "root",
            "password": "secret",
            "redis_sentinel_password": "sentinel",
            "connection_secrets": { "apiKey": "k" },
            "connection_string": "oracle://user:pw@host",
            "init_script": "CREATE SECRET (TYPE POSTGRES, PASSWORD 'x')",
            "transport_layers": [
                { "type": "ssh", "password": "ssh-pw", "key_passphrase": "phrase" },
                { "type": "proxy", "password": "proxy-pw" },
                { "type": "http_tunnel", "token": "tunnel-token" },
            ],
        }))
        .expect("deserialize test connection config");
        redact_connection_sensitive_fields(&mut config);

        assert!(config.password.is_empty());
        assert!(config.redis_sentinel_password.is_empty());
        assert!(config.connection_secrets.is_empty());
        assert!(config.connection_string.is_none());
        assert!(config.init_script.is_none());
        match &config.transport_layers[0] {
            TransportLayerConfig::Ssh(layer) => {
                assert!(layer.password.is_empty());
                assert!(layer.key_passphrase.is_empty());
            }
            _ => panic!("expected ssh layer"),
        }
        match &config.transport_layers[1] {
            TransportLayerConfig::Proxy(layer) => assert!(layer.password.is_empty()),
            _ => panic!("expected proxy layer"),
        }
        match &config.transport_layers[2] {
            TransportLayerConfig::HttpTunnel(layer) => assert!(layer.token.is_empty()),
            _ => panic!("expected http tunnel layer"),
        }
    }
}
