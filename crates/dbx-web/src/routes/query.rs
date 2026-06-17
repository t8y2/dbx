use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteQueryRequest {
    pub connection_id: String,
    pub database: String,
    pub sql: String,
    pub schema: Option<String>,
    pub execution_id: Option<String>,
    pub max_rows: Option<usize>,
    pub fetch_size: Option<usize>,
    pub page_size: Option<usize>,
    pub result_session_id: Option<String>,
    pub client_session_id: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub execution_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub connection_id: String,
    pub database: String,
    pub session_id: String,
    pub client_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseClientConnectionSessionRequest {
    pub connection_id: String,
    pub database: String,
    pub client_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteBatchRequest {
    pub connection_id: String,
    pub database: String,
    pub statements: Vec<String>,
    pub schema: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSqlReferencesRequest {
    pub sql: String,
    pub dialect: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeEditableQueryRequest {
    pub sql: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindStatementAtCursorRequest {
    pub sql: String,
    pub cursor_pos: usize,
    pub database_type: Option<dbx_core::models::connection::DatabaseType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareQueryPaginationExecutionPlanRequest {
    pub options: dbx_core::query_result_sql::QueryPaginationExecutionPlanOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSortedQuerySqlRequest {
    pub options: dbx_core::query_result_sql::SortedQuerySqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExplainSqlRequest {
    pub options: dbx_core::query_execution_sql::ExplainSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDroppedFilePreviewSqlRequest {
    pub options: dbx_core::query_execution_sql::DroppedFilePreviewSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTableSelectSqlRequest {
    pub options: dbx_core::sql_dialect::TableDataSelectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseSearchSqlRequest {
    pub options: dbx_core::database_search_sql::DatabaseSearchSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSearchResultWhereRequest {
    pub options: dbx_core::database_search_sql::SearchResultWhereOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRenameObjectSqlRequest {
    pub options: dbx_core::db_admin_sql::RenameObjectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCreateDatabaseSqlRequest {
    pub options: dbx_core::db_admin_sql::CreateDatabaseSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDuckDbAttachDatabaseSqlRequest {
    pub options: dbx_core::db_admin_sql::DuckDbAttachDatabaseSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDropObjectSqlRequest {
    pub options: dbx_core::db_admin_sql::DropObjectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTableAdminSqlRequest {
    pub options: dbx_core::db_admin_sql::TableAdminSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDropTableChildObjectSqlRequest {
    pub options: dbx_core::db_admin_sql::DropTableChildObjectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseNameSqlRequest {
    pub options: dbx_core::db_admin_sql::DatabaseNameSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSchemaNameSqlRequest {
    pub options: dbx_core::db_admin_sql::SchemaNameSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDuplicateTableStructureSqlRequest {
    pub options: dbx_core::db_admin_sql::DuplicateTableStructureSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExecutableObjectSourceRequest {
    pub input: dbx_core::object_source_sql::EditableObjectSourceSqlInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRoutineRenameObjectSourceRequest {
    pub input: dbx_core::object_source_sql::RoutineRenameObjectSourceInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildViewDdlRequest {
    pub input: dbx_core::object_source_sql::BuildViewDdlInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTableStructureSqlRequest {
    pub options: dbx_core::table_structure_sql::TableStructureSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSingleColumnAlterSqlRequest {
    pub options: dbx_core::table_structure_sql::SingleColumnAlterSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDataGridSaveRequest {
    pub options: dbx_core::data_grid_sql::DataGridSaveStatementOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridCopyUpdateStatementsRequest {
    pub options: dbx_core::data_grid_sql::DataGridCopyUpdateStatementOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridCopyInsertStatementRequest {
    pub options: dbx_core::data_grid_sql::DataGridCopyInsertStatementOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridContextFilterConditionRequest {
    pub options: dbx_core::data_grid_sql::DataGridContextFilterConditionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridColumnValueFilterConditionRequest {
    pub options: dbx_core::data_grid_sql::DataGridColumnValueFilterConditionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridCountSqlRequest {
    pub options: dbx_core::data_grid_sql::DataGridCountSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildHiveTablePropertiesSqlRequest {
    pub options: dbx_core::data_grid_sql::HiveTablePropertiesSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportInsertStatementsRequest {
    pub options: dbx_core::database_export::BuildExportInsertStatementsOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportSqlInsertRequest {
    pub options: dbx_core::database_export::BuildExportSqlInsertOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseSqlExportRequest {
    pub options: dbx_core::database_export::BuildDatabaseSqlExportOptions,
}

pub async fn execute_query(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteQueryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let execution_id = req.execution_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let registered = state.app.running_queries.register(execution_id.clone());
    let cancel_token = registered.token();

    let result = dbx_core::query::execute_sql_statement_with_options(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.sql,
        req.schema.as_deref(),
        Some(cancel_token),
        dbx_core::query::QueryExecutionOptions {
            max_rows: req.max_rows,
            fetch_size: req.fetch_size,
            page_size: req.page_size,
            result_session_id: req.result_session_id,
            client_session_id: req.client_session_id,
            timeout_secs: req.timeout_secs,
            execution_id: Some(execution_id),
        },
    )
    .await
    .map_err(AppError)?;

    drop(registered);
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn execute_multi(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteQueryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let execution_id = req.execution_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let registered = state.app.running_queries.register(execution_id.clone());
    let cancel_token = registered.token();

    let result = dbx_core::query::execute_multi_core_with_options(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.sql,
        req.schema.as_deref(),
        Some(cancel_token),
        dbx_core::query::QueryExecutionOptions {
            max_rows: req.max_rows,
            fetch_size: req.fetch_size,
            page_size: req.page_size,
            result_session_id: req.result_session_id,
            client_session_id: req.client_session_id,
            timeout_secs: req.timeout_secs,
            execution_id: Some(execution_id),
        },
    )
    .await
    .map_err(AppError)?;

    drop(registered);
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn execute_batch(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteBatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::query::execute_statements(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.statements,
        req.schema.as_deref(),
        req.timeout_secs,
    )
    .await
    .map_err(AppError)?;

    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn cancel_query(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CancelRequest>,
) -> Json<serde_json::Value> {
    let cancelled = state.app.running_queries.cancel(&req.execution_id);
    Json(serde_json::json!({ "cancelled": cancelled }))
}

pub async fn close_query_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CloseSessionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let closed = dbx_core::query::close_query_session(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.session_id,
        req.client_session_id.as_deref(),
    )
    .await
    .map_err(AppError)?;

    Ok(Json(serde_json::json!(closed)))
}

pub async fn close_client_connection_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CloseClientConnectionSessionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = if req.database.trim().is_empty() { None } else { Some(req.database.as_str()) };
    let closed = state
        .app
        .close_client_session_pool(&req.connection_id, database, &req.client_session_id)
        .await
        .map_err(AppError)?;

    Ok(Json(serde_json::json!(closed)))
}

pub async fn execute_script(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteQueryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db_type = {
        let configs = state.app.configs.read().await;
        configs.get(&req.connection_id).map(|config| config.db_type)
    };
    let statements = db_type
        .map(|db_type| dbx_core::sql::split_sql_statements_for_database(&req.sql, db_type))
        .unwrap_or_else(|| dbx_core::sql::split_sql_statements(&req.sql));
    let result = dbx_core::query::execute_statements(
        &state.app,
        &req.connection_id,
        &req.database,
        &statements,
        req.schema.as_deref(),
        None,
    )
    .await
    .map_err(AppError)?;

    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn execute_in_transaction(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteBatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::query::execute_statements_in_transaction(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.statements,
        req.schema.as_deref(),
    )
    .await
    .map_err(AppError)?;

    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn analyze_sql_references(
    Json(req): Json<AnalyzeSqlReferencesRequest>,
) -> Result<Json<dbx_core::sql_analysis::SqlReferenceAnalysis>, AppError> {
    dbx_core::sql_analysis::analyze_sql_references(&req.sql, req.dialect.as_deref()).map(Json).map_err(AppError)
}

pub async fn find_statement_at_cursor(Json(req): Json<FindStatementAtCursorRequest>) -> Json<String> {
    Json(
        req.database_type
            .map(|db_type| dbx_core::sql::find_statement_at_cursor_for_database(&req.sql, req.cursor_pos, db_type))
            .unwrap_or_else(|| dbx_core::sql::find_statement_at_cursor(&req.sql, req.cursor_pos)),
    )
}

pub async fn prepare_query_pagination_execution_plan(
    Json(req): Json<PrepareQueryPaginationExecutionPlanRequest>,
) -> Json<dbx_core::query_result_sql::QueryPaginationExecutionPlan> {
    Json(dbx_core::query_result_sql::build_query_pagination_execution_plan(req.options))
}

pub async fn build_sorted_query_sql(
    Json(req): Json<BuildSortedQuerySqlRequest>,
) -> Json<dbx_core::query_result_sql::QuerySqlBuildResult> {
    Json(dbx_core::query_result_sql::build_sorted_query_sql(req.options))
}

pub async fn build_explain_sql(
    Json(req): Json<BuildExplainSqlRequest>,
) -> Json<dbx_core::query_execution_sql::ExplainSqlBuildResult> {
    Json(dbx_core::query_execution_sql::build_explain_sql(req.options))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetExplainInfoRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub sql: String,
    pub mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCreateUserSqlRequest {
    pub username: String,
    pub password: String,
    pub tablespace: String,
}

pub async fn get_explain_info(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GetExplainInfoRequest>,
) -> Result<Json<String>, AppError> {
    let database_for_pool = req.database.as_deref().filter(|database| !database.trim().is_empty());
    state.app.get_or_create_pool(&req.connection_id, database_for_pool).await.map_err(AppError)?;

    let client = {
        let connections = state.app.connections.read().await;
        let pool = connections.get(&req.connection_id).ok_or_else(|| AppError("Connection not found".to_string()))?;
        match pool {
            dbx_core::connection::PoolKind::Agent(client) => client.clone(),
            _ => return Err(AppError("Connection is not an agent-based connection".to_string())),
        }
    };

    let config = {
        let configs = state.app.configs.read().await;
        configs.get(&req.connection_id).cloned()
    };
    let config = config.ok_or_else(|| AppError("Connection config not found".to_string()))?;
    let timeout_secs = config.query_timeout_secs;

    let mut client = client.lock().await;
    let mode = req.mode.unwrap_or_else(|| "explain".to_string());
    if mode.eq_ignore_ascii_case("autotrace") && !dbx_core::query_execution_sql::is_safe_dameng_autotrace_sql(&req.sql)
    {
        return Err(AppError("unsafe".to_string()));
    }
    let params = serde_json::json!({
        "sql": req.sql,
        "database": req.database.unwrap_or_default(),
        "schema": req.schema.unwrap_or_default(),
        "timeoutSecs": timeout_secs as i64,
        "mode": mode,
    });

    let result: Result<serde_json::Value, String> = client.get_explain_info::<serde_json::Value>(params).await;
    match result {
        Ok(serde_json::Value::String(s)) => Ok(Json(s)),
        Ok(serde_json::Value::Object(obj)) => {
            let plan = obj.get("plan").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(Json(plan))
        }
        Ok(val) => Err(AppError(format!("Unexpected result type from getExplainInfo: {:?}", val))),
        Err(e) => Err(AppError(e)),
    }
}

pub async fn build_create_user_sql(Json(req): Json<BuildCreateUserSqlRequest>) -> Result<Json<String>, AppError> {
    Ok(Json(dbx_core::db_admin_sql::build_create_user_sql(&req.username, &req.password, &req.tablespace)))
}

pub async fn build_dropped_file_preview_sql(
    Json(req): Json<BuildDroppedFilePreviewSqlRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::query_execution_sql::build_dropped_file_preview_sql(req.options))
}

pub async fn build_table_select_sql(Json(req): Json<BuildTableSelectSqlRequest>) -> Json<String> {
    Json(dbx_core::sql_dialect::build_table_data_select_sql(req.options))
}

pub async fn build_database_search_sql(
    Json(req): Json<BuildDatabaseSearchSqlRequest>,
) -> Json<Option<dbx_core::database_search_sql::DatabaseSearchSql>> {
    Json(dbx_core::database_search_sql::build_database_search_sql(req.options))
}

pub async fn build_search_result_where(Json(req): Json<BuildSearchResultWhereRequest>) -> Json<String> {
    Json(dbx_core::database_search_sql::build_search_result_where(req.options))
}

pub async fn build_rename_object_sql(Json(req): Json<BuildRenameObjectSqlRequest>) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_rename_object_sql(req.options).map(Json).map_err(AppError)
}

pub async fn build_create_database_sql(Json(req): Json<BuildCreateDatabaseSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_create_database_sql(req.options))
}

pub async fn build_duckdb_attach_database_sql(Json(req): Json<BuildDuckDbAttachDatabaseSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_duckdb_attach_database_sql(req.options))
}

pub async fn build_drop_object_sql(Json(req): Json<BuildDropObjectSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_object_sql(req.options))
}

pub async fn build_drop_table_sql(Json(req): Json<BuildTableAdminSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_table_sql(req.options))
}

pub async fn build_drop_table_child_object_sql(
    Json(req): Json<BuildDropTableChildObjectSqlRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_drop_table_child_object_sql(req.options).map(Json).map_err(AppError)
}

pub async fn build_empty_table_sql(Json(req): Json<BuildTableAdminSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_empty_table_sql(req.options))
}

pub async fn build_truncate_table_sql(Json(req): Json<BuildTableAdminSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_truncate_table_sql(req.options))
}

pub async fn build_drop_database_sql(Json(req): Json<BuildDatabaseNameSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_database_sql(req.options))
}

pub async fn build_create_schema_sql(Json(req): Json<BuildSchemaNameSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_create_schema_sql(req.options))
}

pub async fn build_drop_schema_sql(Json(req): Json<BuildSchemaNameSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_schema_sql(req.options))
}

pub async fn build_duplicate_table_structure_sql(
    Json(req): Json<BuildDuplicateTableStructureSqlRequest>,
) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_duplicate_table_structure_sql(req.options))
}

pub async fn build_executable_object_source_statements(
    Json(req): Json<BuildExecutableObjectSourceRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    dbx_core::object_source_sql::build_executable_object_source_statements(req.input).map(Json).map_err(AppError)
}

pub async fn build_executable_object_source_sql(
    Json(req): Json<BuildExecutableObjectSourceRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::object_source_sql::build_executable_object_source_sql(req.input).map(Json).map_err(AppError)
}

pub async fn build_routine_rename_object_source_statements(
    Json(req): Json<BuildRoutineRenameObjectSourceRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    dbx_core::object_source_sql::build_routine_rename_object_source_statements(req.input).map(Json).map_err(AppError)
}

pub async fn build_view_ddl_sql(Json(req): Json<BuildViewDdlRequest>) -> Json<String> {
    Json(dbx_core::object_source_sql::build_view_ddl_sql(req.input))
}

pub async fn build_table_structure_change_sql(
    Json(req): Json<BuildTableStructureSqlRequest>,
) -> Json<dbx_core::table_structure_sql::TableStructureSqlResult> {
    Json(dbx_core::table_structure_sql::build_table_structure_change_sql(req.options))
}

pub async fn build_create_table_sql(
    Json(req): Json<BuildTableStructureSqlRequest>,
) -> Json<dbx_core::table_structure_sql::TableStructureSqlResult> {
    Json(dbx_core::table_structure_sql::build_create_table_sql(req.options))
}

pub async fn build_single_column_alter_sql(
    Json(req): Json<BuildSingleColumnAlterSqlRequest>,
) -> Json<dbx_core::table_structure_sql::TableStructureSqlResult> {
    Json(dbx_core::table_structure_sql::build_single_column_alter_sql(req.options))
}

pub async fn analyze_editable_query_editability(
    Json(req): Json<AnalyzeEditableQueryRequest>,
) -> Json<dbx_core::sql_editability::QueryEditability> {
    Json(dbx_core::sql_editability::analyze_editable_query_editability(&req.sql))
}

pub async fn prepare_data_grid_save(
    Json(req): Json<PrepareDataGridSaveRequest>,
) -> Json<dbx_core::data_grid_sql::DataGridSavePreparation> {
    Json(dbx_core::data_grid_sql::prepare_data_grid_save(req.options))
}

pub async fn build_data_grid_copy_update_statements(
    Json(req): Json<BuildDataGridCopyUpdateStatementsRequest>,
) -> Json<Vec<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_copy_update_statements(req.options))
}

pub async fn build_data_grid_copy_insert_statement(
    Json(req): Json<BuildDataGridCopyInsertStatementRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_copy_insert_statement(req.options))
}

pub async fn build_data_grid_context_filter_condition(
    Json(req): Json<BuildDataGridContextFilterConditionRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_context_filter_condition(req.options))
}

pub async fn build_data_grid_column_value_filter_condition(
    Json(req): Json<BuildDataGridColumnValueFilterConditionRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_column_value_filter_condition(req.options))
}

pub async fn build_data_grid_count_sql(Json(req): Json<BuildDataGridCountSqlRequest>) -> Json<String> {
    Json(dbx_core::data_grid_sql::build_data_grid_count_sql(req.options))
}

pub async fn build_hive_table_properties_sql(Json(req): Json<BuildHiveTablePropertiesSqlRequest>) -> Json<String> {
    Json(dbx_core::data_grid_sql::build_hive_table_properties_sql(req.options))
}

pub async fn build_export_insert_statements(
    Json(req): Json<BuildExportInsertStatementsRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    dbx_core::database_export::build_export_insert_statements(req.options).map(Json).map_err(AppError)
}

pub async fn build_export_sql_insert(Json(req): Json<BuildExportSqlInsertRequest>) -> Result<Json<String>, AppError> {
    dbx_core::database_export::build_export_sql_insert(req.options).map(Json).map_err(AppError)
}

pub async fn build_database_sql_export(
    Json(req): Json<BuildDatabaseSqlExportRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::database_export::build_database_sql_export(req.options).map(Json).map_err(AppError)
}
