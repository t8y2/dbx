use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

use dbx_core::query::oracle_datapump::list_oracle_datapump_directories as list_directories;
use dbx_core::query::oracle_datapump::{
    create_oracle_datapump_directory as create_directory, drop_oracle_datapump_directory as drop_directory,
};
pub use dbx_core::query::oracle_datapump::{
    run_oracle_datapump_task, OracleDatapumpDirectory, OracleDatapumpProgress, OracleDatapumpTaskRequest,
};

fn emit_progress(app: &AppHandle, progress: OracleDatapumpProgress) {
    let _ = app.emit("oracle-datapump-progress", progress);
}

/// 启动一次数据泵任务。核心侧在开始时发一条 `Running` 进度、
/// 返回前恰好发一条终态事件（Done/Error/Cancelled）——
/// 与达梦 dump 命令相同的契约，本包装层不自行合成进度。
#[tauri::command]
pub async fn start_oracle_datapump(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: OracleDatapumpTaskRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    dbx_core::export_runtime::spawn_export_task(async move {
        run_oracle_datapump_task(&state, &request, |progress| emit_progress(&app, progress)).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_oracle_datapump(task_id: String) -> Result<(), String> {
    dbx_core::database_export::set_export_cancelled(&task_id).await;
    Ok(())
}

/// 对话框下拉用的 DIRECTORY 对象列表（附服务器路径提示，
/// 让用户知道 .dmp 会落在服务器的哪里）。
#[tauri::command]
pub async fn list_oracle_datapump_directories(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: Option<String>,
) -> Result<Vec<OracleDatapumpDirectory>, String> {
    let state = state.inner().clone();
    list_directories(&state, &connection_id, database.as_deref().unwrap_or("")).await
}

/// 新建 DIRECTORY 对象（只建别名；需要 CREATE ANY DIRECTORY 权限）。
#[tauri::command]
pub async fn create_oracle_datapump_directory(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: Option<String>,
    name: String,
    path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    create_directory(&state, &connection_id, database.as_deref().unwrap_or(""), &name, &path).await
}

/// 删除 DIRECTORY 对象；core 先做外部表依赖预检，被引用时拒绝。
#[tauri::command]
pub async fn drop_oracle_datapump_directory(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: Option<String>,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    drop_directory(&state, &connection_id, database.as_deref().unwrap_or(""), &name).await
}
