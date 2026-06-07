use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;

#[tauri::command]
pub fn prepare_data_compare(
    options: dbx_core::data_compare::DataComparePreparationOptions,
) -> Result<dbx_core::data_compare::DataComparePreparation, String> {
    dbx_core::data_compare::prepare_data_compare(options)
}

#[tauri::command]
pub async fn prepare_data_compare_from_tables(
    state: State<'_, Arc<AppState>>,
    options: dbx_core::data_compare::DataCompareFromTablesOptions,
) -> Result<dbx_core::data_compare::DataCompareFromTablesPreparation, String> {
    dbx_core::data_compare::prepare_data_compare_from_tables(&state, options).await
}

#[tauri::command]
pub async fn prepare_data_compare_missing_target(
    state: State<'_, Arc<AppState>>,
    options: dbx_core::data_compare::DataCompareMissingTargetOptions,
) -> Result<dbx_core::data_compare::DataCompareFromTablesPreparation, String> {
    dbx_core::data_compare::prepare_data_compare_missing_target(&state, options).await
}

#[tauri::command]
pub fn build_data_compare_sync_plan(
    options: dbx_core::data_compare::DataCompareSyncPlanOptions,
) -> dbx_core::data_compare::DataCompareSyncPlan {
    dbx_core::data_compare::build_data_compare_sync_plan(options)
}
