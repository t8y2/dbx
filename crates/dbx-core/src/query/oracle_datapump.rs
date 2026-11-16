//! 基于 oracle-go agent 的 Oracle Data Pump（DBMS_DATAPUMP）编排层。
//!
//! 任务生命周期由 agent 侧（agents/drivers/oracle-go/datapump.go）在一条
//! pinned 连接上管理；本模块负责：解析 agent 连接池、按 `datapump_v1`
//! 能力和连接的只读保护做门控，然后轮询 `oracle_datapump_status` 并把
//! 快照转成任务进度事件，让桌面端对话框的表现与达梦原生 dump 一致。

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::{AgentCapability, AgentMethod, PooledAgentClient};
use crate::models::connection::DatabaseType;
use crate::query::{agent_execute_query_params, connection_readonly_name, QueryExecutionOptions};

const NOT_SUPPORTED_TAG: &str = "oracleDatapumpNotSupported";
const CONNECTION_REQUIRED_TAG: &str = "oracleDatapumpConnectionRequired";
const READONLY_TAG: &str = "oracleDatapumpConnectionReadonly";
const SESSION_TAG: &str = "oracleDatapumpSessionUnavailable";
const STATUS_TAG: &str = "oracleDatapumpStatusFailed";

const START_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(750);

/// 桌面端对话框发来的任务请求；驼峰命名对齐 Go agent 的
/// `datapumpStartRequest`，外加宿主侧的路由字段。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDatapumpTaskRequest {
    pub task_id: String,
    pub connection_id: String,
    #[serde(default)]
    pub database: String,
    pub kind: String,
    pub mode: String,
    pub directory: String,
    pub dumpfile: String,
    #[serde(default)]
    pub logfile: Option<String>,
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub remap_schema_from: Option<String>,
    #[serde(default)]
    pub remap_schema_to: Option<String>,
    #[serde(default)]
    pub table_exists_action: Option<String>,
    #[serde(default)]
    pub compression: bool,
}

/// `oracle-datapump-progress` 事件携带的进度负载；
/// 终态事件（Done/Error/Cancelled）恰好发一次。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDatapumpProgress {
    pub task_id: String,
    pub status: String, // Running | Done | Error | Cancelled
    pub state: String,  // agent 侧状态机的当前值
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// KU$_JOB_STATUS1020 的阶段码（1 定义 / 2 执行 / 3 收尾）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_code: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    /// 终态时带 tag 的错误串，供前端本地化；运行中为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDatapumpDirectory {
    pub name: String,
    pub path: String,
}

/// 把 agent 的蛇形命名失败原因码映射成前端错误 tag（见 i18n
/// backend-errors 的 pattern 表）。未知原因码兜底到通用的任务失败 tag，
/// 保证任何错误都不会被吞掉。
fn reason_tag(reason: &str) -> &'static str {
    match reason {
        "datapump_preflight_directory_missing" => "oracleDatapumpPreflightDirectoryMissing",
        "datapump_preflight_directory_not_writable" => "oracleDatapumpPreflightDirectoryNotWritable",
        "datapump_preflight_directory_no_privilege" => "oracleDatapumpPreflightDirectoryNoPrivilege",
        "datapump_preflight_cross_schema_denied" => "oracleDatapumpPreflightCrossSchemaDenied",
        "datapump_preflight_version_unsupported" => "oracleDatapumpPreflightVersionUnsupported",
        "datapump_preflight_user_unavailable"
        | "datapump_preflight_version_unavailable"
        | "datapump_preflight_directory_unavailable" => "oracleDatapumpPreflightUnavailable",
        "datapump_busy" => "oracleDatapumpBusy",
        "datapump_start_failed" => "oracleDatapumpStartFailed",
        "datapump_completed_with_errors" => "oracleDatapumpJobFailed",
        "datapump_status_failed" => STATUS_TAG,
        "datapump_job_lost" | "datapump_session_closed" => "oracleDatapumpSessionLost",
        "datapump_session_open_failed" | "datapump_connection_missing" => "oracleDatapumpConnectionFailed",
        "datapump_lease_expired" => "oracleDatapumpLeaseExpired",
        "datapump_stopped_externally" | "datapump_canceled" => "oracleDatapumpCancelled",
        "datapump_session_unavailable" => SESSION_TAG,
        // 校验类拒绝：出错字段名在 context 里。
        _ => "oracleDatapumpInvalidRequest",
    }
}

/// 把 agent 的 status JSON 快照转成进度负载。
fn snapshot_progress(task_id: &str, status: Value) -> Option<OracleDatapumpProgress> {
    let state = status["state"].as_str()?.to_string();
    let agent_status = match state.as_str() {
        "running" => "Running",
        "succeeded" => "Done",
        "cancelled" => "Cancelled",
        _ => "Error",
    };
    let error = (agent_status == "Error").then(|| {
        let tag = reason_tag(status["reason"].as_str().unwrap_or(""));
        match status["reason"].as_str() {
            Some(reason) if !reason.is_empty() => format!("[{tag}] {reason}"),
            _ => format!("[{tag}]"),
        }
    });
    Some(OracleDatapumpProgress {
        task_id: task_id.to_string(),
        status: agent_status.to_string(),
        state,
        job_state: status["jobState"].as_str().map(str::to_string),
        percent: status["percent"].as_f64(),
        phase_code: status["phaseCode"].as_f64(),
        error_count: status["errorCount"].as_f64(),
        error_text: status["errorText"].as_str().map(str::to_string),
        elapsed_ms: status["elapsedMs"].as_u64(),
        error,
    })
}

fn terminal(progress: &OracleDatapumpProgress) -> bool {
    matches!(progress.status.as_str(), "Done" | "Error" | "Cancelled")
}

/// 构造带 tag 的终态错误进度。
fn failed_progress(task_id: &str, tag: &str, detail: String) -> OracleDatapumpProgress {
    OracleDatapumpProgress {
        task_id: task_id.to_string(),
        status: "Error".into(),
        state: "failed".into(),
        job_state: None,
        percent: None,
        phase_code: None,
        error_count: None,
        error_text: None,
        elapsed_ms: None,
        error: Some(format!("[{tag}] {detail}")),
    }
}

/// 解析连接对应的 agent 会话池，取出 agent 客户端句柄。
async fn agent_pool(state: &AppState, connection_id: &str, database: &str) -> Result<PoolKind, String> {
    let database = if database.trim().is_empty() { None } else { Some(database) };
    let pool_key = state
        .get_or_create_metadata_pool_for_session(connection_id, database, None)
        .await
        .map_err(|_| format!("[{SESSION_TAG}] agent session could not be opened"))?;
    state.pool_handle(&pool_key).await.ok_or_else(|| format!("[{SESSION_TAG}] agent pool not found"))
}

/// 校验连接是 Oracle 类型并返回其 agent 客户端。
async fn oracle_agent_client(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Arc<PooledAgentClient>, String> {
    let config = state.configs.read().await.get(connection_id).cloned();
    match config {
        Some(config) if config.db_type == DatabaseType::Oracle => {}
        Some(_) => {
            return Err(format!("[{CONNECTION_REQUIRED_TAG}] Data Pump is only available for Oracle connections"))
        }
        None => return Err(format!("[{CONNECTION_REQUIRED_TAG}] connection not found")),
    }
    match agent_pool(state, connection_id, database).await? {
        PoolKind::Agent(client) => Ok(client),
        _ => Err(format!("[{CONNECTION_REQUIRED_TAG}] an agent connection is required")),
    }
}

/// 一次数据泵任务的完整流程：在 agent 上启动，然后轮询状态快照直到终态，
/// 期间尊重共享的导出取消注册表。调用方用 `spawn_export_task` 包裹本函数，
/// 并把 `emit` 转发到 Tauri 事件通道（契约与达梦 dump runner 一致）。
pub async fn run_oracle_datapump_task(
    state: &Arc<AppState>,
    request: &OracleDatapumpTaskRequest,
    emit: impl Fn(OracleDatapumpProgress) + Send + Sync,
) {
    let task_id = request.task_id.clone();
    // 只读连接直接拒绝（导出也会建 master table，一律拦）。
    if crate::query::connection_readonly_name(state, &request.connection_id).await.is_some() {
        emit(failed_progress(&task_id, READONLY_TAG, "connection is read-only".into()));
        return;
    }
    let client = match oracle_agent_client(state, &request.connection_id, &request.database).await {
        Ok(client) => client,
        Err(detail) => {
            // oracle_agent_client 返回的错误串自带 [tag] 前缀，提取出来复用。
            let tag =
                detail.split(']').next().and_then(|head| head.strip_prefix('[')).unwrap_or(SESSION_TAG).to_string();
            let mut progress = failed_progress(&task_id, &tag, String::new());
            progress.error = Some(detail);
            emit(progress);
            return;
        }
    };

    // 表模式下，不带 schema 前缀的表名自动补上当前 schema（否则 Data Pump
    // 按连接用户的 schema 找——SYS 连接下找不到业务表 → ORA-31655 零对象）。
    let tables: Vec<String> = request
        .tables
        .iter()
        .map(|table| {
            if table.contains('.') || request.database.trim().is_empty() {
                table.clone()
            } else {
                format!("{}.{}", request.database.trim().to_uppercase(), table)
            }
        })
        .collect();

    let start_params = json!({
        "operationId": format!("dbx-{}", request.task_id),
        "kind": request.kind,
        "mode": request.mode,
        "directory": request.directory,
        "dumpfile": request.dumpfile,
        "logfile": request.logfile,
        "schemas": request.schemas,
        "tables": tables,
        "remapSchemaFrom": request.remap_schema_from,
        "remapSchemaTo": request.remap_schema_to,
        "tableExistsAction": request.table_exists_action,
        "compression": request.compression,
    });

    let started: Value = {
        let mut client = client.lock().await;
        // 能力门控：旧版 agent 不认识数据泵方法，必须提前给出可理解的报错。
        if !client.supports_capability(AgentCapability::DatapumpV1) {
            drop(client);
            emit(failed_progress(
                &task_id,
                NOT_SUPPORTED_TAG,
                "the Oracle agent does not advertise datapump_v1; update the agent".into(),
            ));
            return;
        }
        match client
            .call_method_with_timeout::<Value>(AgentMethod::OracleDatapumpStart, start_params, Some(START_TIMEOUT))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                drop(client);
                emit(failed_progress(&task_id, STATUS_TAG, error.to_string()));
                return;
            }
        }
    };

    // 启动即失败（校验/预检不过）：把 agent 的原因码映射成 tag，
    // 并把上下文（哪个目录、缺什么角色）拼进错误详情。
    if started["state"] == "failed" {
        let tag = reason_tag(started["reason"].as_str().unwrap_or(""));
        let mut detail = started["reason"].as_str().unwrap_or("start failed").to_string();
        if let Some(context) = started["context"].as_object() {
            let parts: Vec<String> = context.iter().map(|(key, value)| format!("{key}={value}")).collect();
            if !parts.is_empty() {
                detail = format!("{detail} ({})", parts.join(", "));
            }
        }
        emit(failed_progress(&task_id, tag, detail));
        let _ = client
            .lock()
            .await
            .call_method_with_timeout::<Value>(
                AgentMethod::OracleDatapumpClose,
                json!({ "operationId": started["operationId"] }),
                Some(STATUS_TIMEOUT),
            )
            .await;
        return;
    }

    let operation_id = started["operationId"].as_str().unwrap_or_default().to_string();
    // 发一条 0% 的 Running，让前端立即进入运行态。
    emit(OracleDatapumpProgress {
        task_id: task_id.clone(),
        status: "Running".into(),
        state: "running".into(),
        job_state: None,
        percent: Some(0.0),
        phase_code: None,
        error_count: None,
        error_text: None,
        elapsed_ms: Some(0),
        error: None,
    });

    loop {
        // 用户取消：通知 agent 执行 STOP_JOB（干净收场），再发终态事件。
        if crate::data::database_export::is_export_cancelled(&task_id).await {
            let _ = client
                .lock()
                .await
                .call_method_with_timeout::<Value>(
                    AgentMethod::OracleDatapumpStop,
                    json!({ "operationId": operation_id }),
                    Some(STATUS_TIMEOUT),
                )
                .await;
            crate::data::database_export::clear_export_cancelled(&task_id).await;
            emit(OracleDatapumpProgress {
                task_id: task_id.clone(),
                status: "Cancelled".into(),
                state: "cancelled".into(),
                job_state: None,
                percent: None,
                phase_code: None,
                error_count: None,
                error_text: None,
                elapsed_ms: None,
                error: None,
            });
            let _ = client
                .lock()
                .await
                .call_method_with_timeout::<Value>(
                    AgentMethod::OracleDatapumpClose,
                    json!({ "operationId": operation_id }),
                    Some(STATUS_TIMEOUT),
                )
                .await;
            return;
        }

        let status: Value = match client
            .lock()
            .await
            .call_method_with_timeout::<Value>(
                AgentMethod::OracleDatapumpStatus,
                json!({ "operationId": operation_id }),
                Some(STATUS_TIMEOUT),
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                emit(failed_progress(&task_id, STATUS_TAG, error.to_string()));
                return;
            }
        };

        let progress = match snapshot_progress(&task_id, status) {
            Some(progress) => progress,
            None => {
                emit(failed_progress(&task_id, STATUS_TAG, "malformed status snapshot".into()));
                return;
            }
        };
        let done = terminal(&progress);
        emit(progress);
        if done {
            // 终态后清掉 agent 侧的 entry。
            let _ = client
                .lock()
                .await
                .call_method_with_timeout::<Value>(
                    AgentMethod::OracleDatapumpClose,
                    json!({ "operationId": operation_id }),
                    Some(STATUS_TIMEOUT),
                )
                .await;
            return;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// 在 agent 上执行一条 DDL/单行查询并取第一个单元格。
/// DDL（CREATE/DROP DIRECTORY）走与列表相同的 execute_query 通道，
/// 不新增 agent 协议方法。
async fn agent_scalar(client: &Arc<PooledAgentClient>, sql: &str, timeout: Duration) -> Result<Option<Value>, String> {
    let params = agent_execute_query_params(sql, None, None, QueryExecutionOptions::default());
    let result: Value = client
        .lock()
        .await
        .call_method_with_timeout::<Value>(AgentMethod::ExecuteQuery, params, Some(timeout))
        .await
        .map_err(|error| error.to_string())?;
    Ok(result["rows"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row.as_array())
        .and_then(|cells| cells.first())
        .cloned())
}

/// 标识符校验（对齐 agent 侧 datapumpValidateName 的规则）：
/// 非空、≤128、不含引号/NUL/路径分隔符。
fn valid_directory_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.contains('\0') && !name.contains(['\'', '"', '/', '\\'])
}

/// 服务器路径校验：不含 NUL 和单引号（会进 SQL 字符串字面量）。
fn valid_directory_path(path: &str) -> bool {
    !path.trim().is_empty() && path.len() <= 1024 && !path.contains('\0') && !path.contains('\'')
}

/// CREATE/DROP ANY DIRECTORY 权限缺失时 Oracle 报 ORA-01031；
/// 识别出来给前端更可操作的文案。
fn directory_privilege_tag(raw: &str) -> &'static str {
    if raw.contains("ORA-01031") || raw.contains("ORA-00942") {
        "oracleDatapumpDirectoryPrivilegeDenied"
    } else if raw.contains("ORA-65040") {
        // CDB 架构：CREATE/DROP DIRECTORY 只能从 CDB$ROOT 执行，PDB 里不允许。
        "oracleDatapumpDirectoryPdbRestricted"
    } else {
        "oracleDatapumpDirectoryCommandFailed"
    }
}

/// 新建 DIRECTORY 对象（只建"别名"，不动服务器文件系统）。
/// 需要只读放行 + CREATE ANY DIRECTORY 权限（普通用户通常没有，
/// 缺权限时报精确提示而不是裸 ORA 码）。
pub async fn create_oracle_datapump_directory(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    name: &str,
    path: &str,
) -> Result<(), String> {
    let name = name.trim();
    let path = path.trim();
    if !valid_directory_name(name) {
        return Err("[oracleDatapumpDirectoryNameInvalid] directory name is invalid".into());
    }
    if !valid_directory_path(path) {
        return Err("[oracleDatapumpDirectoryPathInvalid] server path is invalid".into());
    }
    if crate::query::connection_readonly_name(state, connection_id).await.is_some() {
        return Err(format!("[{READONLY_TAG}] connection is read-only"));
    }
    let client = oracle_agent_client(state, connection_id, database).await?;
    let sql = format!("CREATE DIRECTORY {} AS '{}'", name.to_uppercase(), path.replace('\'', "''"));
    match agent_scalar(&client, &sql, STATUS_TIMEOUT).await {
        Ok(_) => Ok(()),
        Err(raw) => {
            let tag = directory_privilege_tag(&raw);
            Err(format!("[{tag}] {raw}"))
        }
    }
}

/// 删除 DIRECTORY 对象。删除前做依赖预检：有外部表引用时拒绝（列出数量），
/// 避免删掉别名后外部表/定时任务全部失效。
pub async fn drop_oracle_datapump_directory(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    name: &str,
) -> Result<(), String> {
    let name = name.trim();
    if !valid_directory_name(name) {
        return Err("[oracleDatapumpDirectoryNameInvalid] directory name is invalid".into());
    }
    if crate::query::connection_readonly_name(state, connection_id).await.is_some() {
        return Err(format!("[{READONLY_TAG}] connection is read-only"));
    }
    let client = oracle_agent_client(state, connection_id, database).await?;
    let upper = name.to_uppercase();
    let check_sql = format!(
        "SELECT COUNT(*) FROM SYS.ALL_EXTERNAL_LOCATIONS WHERE DIRECTORY_NAME = '{}'",
        upper.replace('\'', "''")
    );
    let referenced = agent_scalar(&client, &check_sql, STATUS_TIMEOUT)
        .await
        .map_err(|raw| format!("[{}] {raw}", directory_privilege_tag(&raw)))?
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    if referenced > 0 {
        return Err(format!(
            "[oracleDatapumpDirectoryInUse] {referenced} external table location(s) reference this directory"
        ));
    }
    let sql = format!("DROP DIRECTORY {}", upper);
    match agent_scalar(&client, &sql, STATUS_TIMEOUT).await {
        Ok(_) => Ok(()),
        Err(raw) => {
            let tag = directory_privilege_tag(&raw);
            Err(format!("[{tag}] {raw}"))
        }
    }
}

/// 列出 DIRECTORY 对象供对话框下拉选择：走 agent 共享元数据池上的
/// 普通 execute_query 通道。
pub async fn list_oracle_datapump_directories(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
) -> Result<Vec<OracleDatapumpDirectory>, String> {
    let client = oracle_agent_client(state, connection_id, database).await?;
    let sql = "SELECT DIRECTORY_NAME, DIRECTORY_PATH FROM SYS.ALL_DIRECTORIES ORDER BY DIRECTORY_NAME";
    let params = agent_execute_query_params(
        sql,
        Some(database).filter(|database| !database.trim().is_empty()),
        None,
        QueryExecutionOptions { max_rows: Some(1000), ..Default::default() },
    );
    let mut client = client.lock().await;
    if !client.supports_capability(AgentCapability::DatapumpV1) {
        return Err(format!("[{NOT_SUPPORTED_TAG}] the Oracle agent does not advertise datapump_v1; update the agent"));
    }
    let result: Value = client
        .call_method_with_timeout::<Value>(AgentMethod::ExecuteQuery, params, Some(STATUS_TIMEOUT))
        .await
        .map_err(|error| format!("[{STATUS_TAG}] {error}"))?;
    // agent 的 execute_query 返回 { columns: [...], rows: [[v1, v2], ...] }。
    let mut directories = Vec::new();
    if let Some(rows) = result["rows"].as_array() {
        for row in rows {
            let cells = row.as_array();
            let name = cells.and_then(|cells| cells.first()).and_then(Value::as_str).unwrap_or_default().trim();
            if name.is_empty() {
                continue;
            }
            directories.push(OracleDatapumpDirectory {
                name: name.to_string(),
                path: cells
                    .and_then(|cells| cells.get(1))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
            });
        }
    }
    Ok(directories)
}
